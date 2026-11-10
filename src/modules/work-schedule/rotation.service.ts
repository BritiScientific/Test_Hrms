import type { Tx } from '../../config/db';
import type { AuthContext } from '../../shared/types';
import {
  assertFresh, assertNameFree, baseFields, getRecord, guardName, listRecords, lockRow, setStatus,
  type BaseRecord, type ResourceDef,
} from './named-config.service';
import { businessFields, diffFields, writeAudit, type EntityType } from './work-schedule.audit';
import { fieldValidation, inactiveReference, MAX_BLOCKERS, patternFrozen, type Blocker } from './work-schedule.errors';
import type { ListQuery, RotationCreate, RotationPatch, StatusBody } from './work-schedule.schemas';

/**
 * Rotating shifts and rotating work types: the same rules on two tables.
 *
 *  - 2 to 20 entries, no duplicates, every entry active and in this tenant.
 *  - sequence_order is renumbered 1..n from the order of the request array.
 *  - Editing the entries replaces all child rows in the same transaction as
 *    the pattern update and its audit row; any failure rolls back all three.
 */

export interface RotationItem {
  /** Id of the referenced shift or work type. */
  id: number;
  name: string;
  isActive: boolean;
  sequenceOrder: number;
}

export interface Rotation extends BaseRecord {
  rotationInterval: number;
  rotationUnit: 'days' | 'weeks';
  items: RotationItem[];
  /** "Morning > Night" */
  sequenceSummary: string;
  /** Employees currently on (or scheduled for) this rotation. Above 0 the pattern is frozen. */
  activeAssignments: number;
}

interface RotationKind {
  def: ResourceDef<Rotation>;
  itemTable: string;
  refTable: string;
  refColumn: string;
  /** "shift" / "work type", for messages. */
  refLabel: string;
  assignmentTable: string;
  assignmentType: Blocker['type'];
}

const COLUMNS: Record<string, string> = {
  name: 'name', description: 'description', rotationInterval: 'rotation_interval', rotationUnit: 'rotation_unit',
};

function makeKind(o: {
  table: string; itemTable: string; refTable: string; refColumn: string; refLabel: string;
  assignmentTable: string; assignmentType: Blocker['type'];
  entityType: EntityType; label: string; nameIndex: string;
}): RotationKind {
  const kind: RotationKind = {
    itemTable: o.itemTable,
    refTable: o.refTable,
    refColumn: o.refColumn,
    refLabel: o.refLabel,
    assignmentTable: o.assignmentTable,
    assignmentType: o.assignmentType,
    def: {
      table: o.table,
      entityType: o.entityType,
      label: o.label,
      nameIndex: o.nameIndex,
      select: `SELECT p.*, (SELECT count(*) FROM ${o.assignmentTable} a WHERE a.tenant_id = p.tenant_id AND a.pattern_id = p.id
                 AND ${LIVE('a')})::int AS active_assignments FROM ${o.table} p`,
      toApi: (row) => ({
        ...baseFields(row),
        rotationInterval: row.rotation_interval,
        rotationUnit: row.rotation_unit,
        items: [],
        sequenceSummary: '',
        activeAssignments: row.active_assignments ?? 0,
      }),
      attach: (tx, records) => attachItems(tx, kind, records),
      // Deactivation is blocked while employees are on the rotation; the blockers are the assignments.
      dependents: (tx, id) => liveAssignments(tx, kind, id),
      activationCheck: (tx, row) => assertItemsActive(tx, kind, Number(row.id)),
    },
  };
  return kind;
}

/** An assignment is live while it is not cancelled and its end date is empty or not yet past (tenant timezone). */
export const LIVE = (alias: string) =>
  `${alias}.status <> 'cancelled' AND (${alias}.end_date IS NULL OR ${alias}.end_date >= ws_tenant_today(${alias}.tenant_id))`;

async function liveAssignments(tx: Tx, kind: RotationKind, patternId: number) {
  const r = await tx.query(
    `SELECT a.id, e.full_name AS name, count(*) OVER ()::int AS total
       FROM ${kind.assignmentTable} a
       JOIN employees e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
      WHERE a.pattern_id = $1 AND ${LIVE('a')}
      ORDER BY lower(e.full_name), a.id LIMIT $2`,
    [patternId, MAX_BLOCKERS],
  );
  return {
    total: r.rows[0]?.total ?? 0,
    items: r.rows.map((x): Blocker => ({ type: kind.assignmentType, id: Number(x.id), name: x.name })),
  };
}

export const rotatingShiftKind = makeKind({
  table: 'rotating_shift_patterns', itemTable: 'rotating_shift_pattern_items',
  refTable: 'work_shifts', refColumn: 'shift_id', refLabel: 'shift',
  assignmentTable: 'rotating_shift_assignments', assignmentType: 'rotating_shift_assignment',
  entityType: 'rotating_shift', label: 'Rotating shift', nameIndex: 'uq_rotating_shift_patterns_name',
});

export const rotatingWorkTypeKind = makeKind({
  table: 'rotating_work_type_patterns', itemTable: 'rotating_work_type_pattern_items',
  refTable: 'work_types', refColumn: 'work_type_id', refLabel: 'work type',
  assignmentTable: 'rotating_work_type_assignments', assignmentType: 'rotating_work_type_assignment',
  entityType: 'rotating_work_type', label: 'Rotating work type', nameIndex: 'uq_rotating_work_type_patterns_name',
});

// ------------------------------------------------------------------ reads ---

async function attachItems(tx: Tx, kind: RotationKind, records: Rotation[]): Promise<Rotation[]> {
  const r = await tx.query(
    `SELECT i.pattern_id, i.sequence_order, x.id, x.name, x.is_active
       FROM ${kind.itemTable} i
       JOIN ${kind.refTable} x ON x.tenant_id = i.tenant_id AND x.id = i.${kind.refColumn}
      WHERE i.pattern_id = ANY($1::bigint[])
      ORDER BY i.pattern_id, i.sequence_order`,
    [records.map((p) => p.id)],
  );
  const byPattern = new Map<number, RotationItem[]>();
  for (const row of r.rows) {
    const list = byPattern.get(Number(row.pattern_id)) ?? [];
    list.push({ id: Number(row.id), name: row.name, isActive: row.is_active, sequenceOrder: row.sequence_order });
    byPattern.set(Number(row.pattern_id), list);
  }
  return records.map((p) => {
    const items = byPattern.get(p.id) ?? [];
    return { ...p, items, sequenceSummary: items.map((i) => i.name).join(' > ') };
  });
}

export const listRotations = (tx: Tx, kind: RotationKind, q: ListQuery) => listRecords(tx, kind.def, q);
export const getRotation = (tx: Tx, kind: RotationKind, id: number) => getRecord(tx, kind.def, id);

// --------------------------------------------------------------- checks ---

/**
 * Every referenced row must exist in this tenant and be active. FOR SHARE
 * holds them until commit, so a concurrent deactivation waits for this
 * transaction and then sees the new rotation as a dependent.
 */
async function assertRefsUsable(tx: Tx, kind: RotationKind, ids: number[]) {
  const r = await tx.query(
    `SELECT id, name, is_active FROM ${kind.refTable} WHERE id = ANY($1::bigint[]) FOR SHARE`,
    [ids],
  );
  const found = new Map(r.rows.map((x) => [Number(x.id), x]));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    throw fieldValidation(`Unknown ${kind.refLabel}`, { items: `Unknown ${kind.refLabel}: ${missing.join(', ')}` });
  }
  const inactive = ids.map((id) => found.get(id)).filter((x) => !x.is_active);
  if (inactive.length) {
    throw inactiveReference(
      `Deactivated ${kind.refLabel}${inactive.length > 1 ? 's' : ''} cannot be used: ${inactive.map((x) => x.name).join(', ')}`,
      'items',
    );
  }
}

/** Reactivation: every entry the rotation holds must still be active. */
async function assertItemsActive(tx: Tx, kind: RotationKind, patternId: number) {
  const r = await tx.query(
    `SELECT x.id, x.name, x.is_active FROM ${kind.itemTable} i
       JOIN ${kind.refTable} x ON x.tenant_id = i.tenant_id AND x.id = i.${kind.refColumn}
      WHERE i.pattern_id = $1
        FOR SHARE OF x`,
    [patternId],
  );
  const inactive = r.rows.filter((x) => !x.is_active);
  if (inactive.length) {
    throw inactiveReference(
      `Cannot activate: deactivated ${kind.refLabel}${inactive.length > 1 ? 's' : ''} ${inactive.map((x) => `"${x.name}"`).join(', ')}. Edit the rotation first.`,
    );
  }
  if (r.rowCount! < 2) throw fieldValidation('A rotation needs at least 2 entries', { items: 'Add at least 2 entries' });
}

/** Defence in depth: the schema already enforces this for HTTP callers. */
function assertItemShape(ids: number[]) {
  if (ids.length < 2) throw fieldValidation('A rotation needs at least 2 entries', { items: 'Add at least 2 entries' });
  if (ids.length > 20) throw fieldValidation('A rotation has at most 20 entries', { items: 'At most 20 entries' });
  if (new Set(ids).size !== ids.length) throw fieldValidation('Each entry can appear only once', { items: 'Each entry can appear only once' });
}

async function writeItems(tx: Tx, kind: RotationKind, tenantId: number, patternId: number, ids: number[]) {
  await tx.query(`DELETE FROM ${kind.itemTable} WHERE pattern_id = $1`, [patternId]);
  await tx.query(
    `INSERT INTO ${kind.itemTable} (tenant_id, pattern_id, ${kind.refColumn}, sequence_order)
     SELECT $1, $2, ref_id, ord::int FROM unnest($3::bigint[]) WITH ORDINALITY AS u(ref_id, ord)`,
    [tenantId, patternId, ids],
  );
}

// ---------------------------------------------------------------- writes ---

export async function createRotation(tx: Tx, auth: AuthContext, kind: RotationKind, body: RotationCreate) {
  const { def } = kind;
  assertItemShape(body.items);
  await assertNameFree(tx, def.table, def.label, body.name);
  await assertRefsUsable(tx, kind, body.items);

  const r = await guardName(def, () => tx.query(
    `INSERT INTO ${def.table}
       (tenant_id, name, description, rotation_interval, rotation_unit, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
    [auth.tenantId, body.name, body.description ?? null, body.rotationInterval, body.rotationUnit, auth.userId],
  ));
  const id = Number(r.rows[0].id);
  await writeItems(tx, kind, auth.tenantId, id, body.items);

  const created = await getRecord(tx, def, id);
  await writeAudit(tx, auth, {
    action: 'created', entityType: def.entityType, entityId: id, before: null, after: auditView(created),
  });
  return created;
}

export async function updateRotation(tx: Tx, auth: AuthContext, kind: RotationKind, id: number, body: RotationPatch) {
  const { def } = kind;
  const row = await lockRow(tx, def.table, id, def.label);
  assertFresh(row, body.updatedAt);
  const before = await getRecord(tx, def, id);

  const changes: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(COLUMNS)) {
    const next = (body as Record<string, unknown>)[key];
    if (next !== undefined && JSON.stringify(row[column] ?? null) !== JSON.stringify(next ?? null)) changes[column] = next;
  }
  const currentIds = before.items.map((i) => i.id);
  const itemsChanged = body.items !== undefined && JSON.stringify(body.items) !== JSON.stringify(currentIds);
  if (!Object.keys(changes).length && !itemsChanged) return before;

  // Interval, unit and entries decide everyone's current entry: frozen while employees are on the rotation.
  const frozenChange = itemsChanged;
  if (frozenChange) {
    const live = await liveAssignments(tx, kind, id);
    if (live.total > 0) throw patternFrozen(def.label, live.total, live.items);
  }
  if (changes.name !== undefined) await assertNameFree(tx, def.table, def.label, String(changes.name), id);
  if (itemsChanged) {
    assertItemShape(body.items!);
    await assertRefsUsable(tx, kind, body.items!);
    await writeItems(tx, kind, auth.tenantId, id, body.items!);
  }

  // Always touch the pattern, so its updated_at (the lock token) moves even when only items changed.
  const sets = Object.keys(changes);
  await guardName(def, () => tx.query(
    `UPDATE ${def.table}
        SET ${[...sets.map((c, i) => `${c} = $${i + 2}`), `updated_by = $${sets.length + 2}`].join(', ')}
      WHERE id = $1`,
    [id, ...sets.map((c) => changes[c]), auth.userId],
  ));

  const after = await getRecord(tx, def, id);
  const diff = diffFields(auditView(before), auditView(after));
  if (diff) await writeAudit(tx, auth, { action: 'updated', entityType: def.entityType, entityId: id, ...diff });
  return after;
}

export const setRotationStatus = (tx: Tx, auth: AuthContext, kind: RotationKind, id: number, body: StatusBody) =>
  setStatus(tx, auth, kind.def, id, body);

/** Audit keeps the entries as ordered ids and names, not their live active flags. */
function auditView(r: Rotation): Record<string, unknown> {
  return businessFields({
    ...r,
    items: r.items.map((i) => ({ id: i.id, name: i.name, sequenceOrder: i.sequenceOrder })),
  });
}
