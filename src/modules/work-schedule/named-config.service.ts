import type { Tx } from '../../config/db';
import { notFound } from '../../shared/errors';
import type { AuthContext } from '../../shared/types';
import { businessFields, diffFields, writeAudit, type EntityType } from './work-schedule.audit';
import {
  hasActiveDependents, nameTaken, rethrowNameTaken, staleVersion, type Blocker,
} from './work-schedule.errors';
import type { ListQuery, StatusBody } from './work-schedule.schemas';

/**
 * Shared list, get, create, patch and set-status logic.
 *
 * Every resource in this module is described by a ResourceDef; the three
 * plain masters (employee types, shifts, work types) use everything here,
 * and the rotation and schedule services reuse list/get/status and the
 * locking helpers while writing their own children.
 *
 * Every write follows the same transaction pattern (the caller's `tx` is the
 * withTenantTx transaction, so RLS scopes every statement to the tenant):
 *   1. lock the target row FOR UPDATE and compare updatedAt,
 *   2. check dependents and references,
 *   3. write the change, then the audit row,
 *   4. commit — or roll back parent, children and audit together.
 */

export interface BaseRecord {
  id: number;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy: number | null;
  updatedBy: number | null;
}

export interface Dependents { total: number; items: Blocker[] }

export interface ResourceDef<T extends BaseRecord> {
  table: string;
  entityType: EntityType;
  /** Human name, e.g. "Shift". */
  label: string;
  /** Unique index on (tenant_id, lower(name)), for NAME_TAKEN. */
  nameIndex: string;
  /** A SELECT whose rows `toApi` maps; it must expose id, name, description, is_active, created_at, updated_at. */
  select: string;
  toApi(row: any): T;
  /** Load child rows (rotation items, schedule days) for a page of records. */
  attach?(tx: Tx, records: T[]): Promise<T[]>;
  /** Active records that block deactivation. */
  dependents?(tx: Tx, id: number): Promise<Dependents>;
  /** Extra checks before (re)activation, e.g. every referenced shift is active. */
  activationCheck?(tx: Tx, row: any): Promise<void>;
}

export const baseFields = (row: any): BaseRecord => ({
  id: Number(row.id),
  name: row.name,
  description: row.description ?? null,
  isActive: row.is_active,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  createdBy: row.created_by == null ? null : Number(row.created_by),
  updatedBy: row.updated_by == null ? null : Number(row.updated_by),
});

const SORT_SQL: Record<string, string> = {
  name: 'lower(t.name)',
  createdAt: 't.created_at',
  updatedAt: 't.updated_at',
};

/** A record viewed as plain fields, for audit snapshots. */
const asFields = (r: BaseRecord): Record<string, unknown> => ({ ...r });

/** Escape a user search term for ILIKE (backslash is PostgreSQL's default escape). */
const likeTerm = (s: string) => `%${s.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// ------------------------------------------------------------------ reads ---

export async function listRecords<T extends BaseRecord>(tx: Tx, def: ResourceDef<T>, q: ListQuery) {
  const desc = q.sort.startsWith('-');
  const key = desc ? q.sort.slice(1) : q.sort;
  const order = SORT_SQL[key] ?? SORT_SQL.name; // whitelisted by the schema too
  const offset = (q.page - 1) * q.limit;
  const r = await tx.query(
    `SELECT t.*, count(*) OVER ()::int AS total_count
       FROM (${def.select}) t
      WHERE ($1::text IS NULL OR t.name ILIKE $1 OR t.description ILIKE $1)
        AND ($2::text = 'all' OR t.is_active = ($2 = 'active'))
      ORDER BY ${order} ${desc ? 'DESC' : 'ASC'}, t.id
      LIMIT $3 OFFSET $4`,
    [q.search ? likeTerm(q.search) : null, q.status, q.limit, offset],
  );
  let items = r.rows.map((row) => def.toApi(row));
  if (def.attach && items.length) items = await def.attach(tx, items);
  return { items, total: r.rows[0]?.total_count ?? 0, page: q.page, limit: q.limit };
}

/** Inactive records are returned too, so history stays readable. */
export async function getRecord<T extends BaseRecord>(tx: Tx, def: ResourceDef<T>, id: number): Promise<T> {
  const r = await tx.query(`SELECT t.* FROM (${def.select}) t WHERE t.id = $1`, [id]);
  if (!r.rowCount) throw notFound(def.label);
  const record = def.toApi(r.rows[0]);
  return def.attach ? (await def.attach(tx, [record]))[0] : record;
}

/** Active records only, for pickers. */
export async function activeOptions(tx: Tx, table: string, extra = '') {
  const r = await tx.query(
    `SELECT id, name${extra ? `, ${extra}` : ''} FROM ${table} WHERE is_active ORDER BY lower(name), id`,
  );
  return r.rows;
}

// ---------------------------------------------------------- write helpers ---

/** Step 1 of every write: lock the row. 404 for a missing or other-tenant id (RLS hides it). */
export async function lockRow(tx: Tx, table: string, id: number, label: string) {
  const r = await tx.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  if (!r.rowCount) throw notFound(label);
  return r.rows[0];
}

/**
 * updated_at is microsecond precision; a JS Date (and so the client's copy)
 * is milliseconds. pg truncates when parsing, so compare at milliseconds.
 */
export function assertFresh(row: { updated_at: Date }, clientUpdatedAt: string) {
  if (row.updated_at.getTime() !== new Date(clientUpdatedAt).getTime()) throw staleVersion(row.updated_at);
}

/** Case-insensitive name check inside the tenant; the unique index is the backstop for races. */
export async function assertNameFree(tx: Tx, table: string, label: string, name: string, exceptId?: number) {
  const r = await tx.query(
    `SELECT 1 FROM ${table} WHERE lower(name) = lower($1) AND ($2::bigint IS NULL OR id <> $2)`,
    [name.trim(), exceptId ?? null],
  );
  if (r.rowCount) throw nameTaken(label);
}

/** Run a statement that may hit the name index; turns that one violation into NAME_TAKEN. */
export async function guardName<R>(def: { nameIndex: string; label: string }, run: () => Promise<R>): Promise<R> {
  try {
    return await run();
  } catch (err) {
    rethrowNameTaken(err, def.nameIndex, def.label);
  }
}

// -------------------------------------------------------- status change ---

/**
 * Activate or deactivate. Repeating the current state returns 200 with the
 * record and writes no audit row.
 */
export async function setStatus<T extends BaseRecord>(
  tx: Tx, auth: AuthContext, def: ResourceDef<T>, id: number, body: StatusBody,
): Promise<T> {
  const row = await lockRow(tx, def.table, id, def.label);
  if (row.is_active === body.isActive) return getRecord(tx, def, id);
  assertFresh(row, body.updatedAt);

  if (!body.isActive && def.dependents) {
    const deps = await def.dependents(tx, id);
    if (deps.total > 0) throw hasActiveDependents(def.label, deps.total, deps.items);
  }
  if (body.isActive && def.activationCheck) await def.activationCheck(tx, row);

  await tx.query(`UPDATE ${def.table} SET is_active = $2, updated_by = $3 WHERE id = $1`,
    [id, body.isActive, auth.userId]);
  await writeAudit(tx, auth, {
    action: body.isActive ? 'activated' : 'deactivated',
    entityType: def.entityType,
    entityId: id,
    before: { isActive: row.is_active },
    after: { isActive: body.isActive },
  });
  return getRecord(tx, def, id);
}

// ----------------------------------------------- plain master create/patch ---

/** API field -> column. Column names come from code, never from input. */
export type ColumnMap = Record<string, string>;

export async function createRecord<T extends BaseRecord>(
  tx: Tx, auth: AuthContext, def: ResourceDef<T>, columns: ColumnMap, body: Record<string, unknown>,
): Promise<T> {
  await assertNameFree(tx, def.table, def.label, String(body.name));
  const fields = Object.entries(columns).filter(([k]) => body[k] !== undefined);
  const cols = ['tenant_id', 'created_by', 'updated_by', ...fields.map(([, c]) => c)];
  const values = [auth.tenantId, auth.userId, auth.userId, ...fields.map(([k]) => body[k])];
  const r = await guardName(def, () => tx.query(
    `INSERT INTO ${def.table} (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    values,
  ));
  const id = Number(r.rows[0].id);
  const created = await getRecord(tx, def, id);
  await writeAudit(tx, auth, {
    action: 'created', entityType: def.entityType, entityId: id, before: null, after: businessFields(asFields(created)),
  });
  return created;
}

export async function patchRecord<T extends BaseRecord>(
  tx: Tx, auth: AuthContext, def: ResourceDef<T>, columns: ColumnMap, id: number,
  body: Record<string, unknown> & { updatedAt: string },
  beforeWrite?: (row: any, changes: Record<string, unknown>) => Promise<void>,
): Promise<T> {
  const row = await lockRow(tx, def.table, id, def.label);
  assertFresh(row, body.updatedAt);

  // Only columns whose value actually changes: a no-op edit keeps updated_at.
  const changes: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(columns)) {
    if (body[key] === undefined) continue;
    const next = typeof body[key] === 'string' ? (body[key] as string).trim() : body[key];
    if (JSON.stringify(row[column] ?? null) !== JSON.stringify(next ?? null)) changes[column] = next;
  }
  if (!Object.keys(changes).length) return getRecord(tx, def, id);

  if (changes.name !== undefined) await assertNameFree(tx, def.table, def.label, String(changes.name), id);
  if (beforeWrite) await beforeWrite(row, changes);

  const before = await getRecord(tx, def, id);
  const sets = Object.keys(changes);
  await guardName(def, () => tx.query(
    `UPDATE ${def.table} SET ${sets.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_by = $${sets.length + 2}
      WHERE id = $1`,
    [id, ...sets.map((c) => changes[c]), auth.userId],
  ));
  const after = await getRecord(tx, def, id);
  const diff = diffFields(asFields(before), asFields(after));
  if (diff) {
    await writeAudit(tx, auth, { action: 'updated', entityType: def.entityType, entityId: id, ...diff });
  }
  return after;
}
