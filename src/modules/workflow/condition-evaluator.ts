/**
 * Allow-listed, data-only step conditions. Never eval() stored JSON.
 *
 * A step's `condition` decides whether that step APPLIES to an instance:
 *   { "field": "totalDays", "op": "gt", "value": 3 }
 *   { "all": [ {...}, {...} ] }   { "any": [ ... ] }   { "not": {...} }
 *
 * Expense example from the doc, expressed per step (no overlapping ranges):
 *   step 1 Manager  -> condition: null                         (always)
 *   step 2 Finance  -> { "field": "amount", "op": "gte", "value": 5000 }
 *   step 3 HR       -> { "field": "amount", "op": "gt",  "value": 20000 }
 * `between` is half-open [min, max) so adjacent bands never both match.
 */

export type FieldType = 'number' | 'string' | 'boolean';
export type ContextSchema = Record<string, FieldType>;

const OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'not_in'] as const;
export type Operator = (typeof OPS)[number];

export type Condition =
  | { field: string; op: Operator; value: unknown }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

const MAX_DEPTH = 5;
const MAX_NODES = 50;

export function validateCondition(cond: unknown, schema: ContextSchema): string[] {
  const errors: string[] = [];
  let nodes = 0;

  const walk = (c: any, depth: number, path: string) => {
    if (++nodes > MAX_NODES) { errors.push('condition too large'); return; }
    if (depth > MAX_DEPTH) { errors.push(`${path}: nesting deeper than ${MAX_DEPTH}`); return; }
    if (!c || typeof c !== 'object' || Array.isArray(c)) { errors.push(`${path}: must be an object`); return; }
    const keys = Object.keys(c);

    if ('all' in c || 'any' in c) {
      const k = 'all' in c ? 'all' : 'any';
      if (keys.length !== 1 || !Array.isArray(c[k]) || c[k].length === 0) {
        errors.push(`${path}.${k}: must be a non-empty array and the only key`); return;
      }
      c[k].forEach((child: unknown, i: number) => walk(child, depth + 1, `${path}.${k}[${i}]`));
      return;
    }
    if ('not' in c) {
      if (keys.length !== 1) { errors.push(`${path}.not: must be the only key`); return; }
      walk(c.not, depth + 1, `${path}.not`); return;
    }

    const { field, op, value } = c;
    if (keys.some((k) => !['field', 'op', 'value'].includes(k))) errors.push(`${path}: unexpected keys`);
    if (typeof field !== 'string' || !(field in schema)) {
      errors.push(`${path}.field: unknown field "${field}" (allowed: ${Object.keys(schema).join(', ')})`);
      return;
    }
    if (!OPS.includes(op)) { errors.push(`${path}.op: unsupported operator "${op}"`); return; }
    const t = schema[field];
    const ok = (v: unknown) => typeof v === t;

    if (op === 'between') {
      if (t !== 'number' || !Array.isArray(value) || value.length !== 2 || !value.every(ok) || value[0] >= value[1]) {
        errors.push(`${path}.value: between needs [min, max] numbers with min < max`);
      }
    } else if (op === 'in' || op === 'not_in') {
      if (!Array.isArray(value) || value.length === 0 || value.length > 100 || !value.every(ok)) {
        errors.push(`${path}.value: ${op} needs a non-empty array of ${t}`);
      }
    } else if (['gt', 'gte', 'lt', 'lte'].includes(op)) {
      if (t !== 'number' || !ok(value)) errors.push(`${path}.value: ${op} needs a number field and value`);
    } else if (!ok(value)) {
      errors.push(`${path}.value: expected ${t}`);
    }
  };

  walk(cond, 1, '$');
  return errors;
}

export function evaluateCondition(cond: Condition, ctx: Record<string, unknown>): boolean {
  if ('all' in cond) return cond.all.every((c) => evaluateCondition(c, ctx));
  if ('any' in cond) return cond.any.some((c) => evaluateCondition(c, ctx));
  if ('not' in cond) return !evaluateCondition(cond.not, ctx);

  if (!(cond.field in ctx)) {
    // Contexts are validated against the module schema at start, so this is a bug.
    throw new Error(`Condition field "${cond.field}" missing from workflow context`);
  }
  const v: any = ctx[cond.field];
  const x: any = cond.value;
  switch (cond.op) {
    case 'eq': return v === x;
    case 'neq': return v !== x;
    case 'gt': return v > x;
    case 'gte': return v >= x;
    case 'lt': return v < x;
    case 'lte': return v <= x;
    case 'between': return v >= x[0] && v < x[1];
    case 'in': return (x as unknown[]).includes(v);
    case 'not_in': return !(x as unknown[]).includes(v);
  }
}

export function assertContextMatchesSchema(ctx: Record<string, unknown>, schema: ContextSchema) {
  for (const [k, t] of Object.entries(schema)) {
    if (typeof ctx[k] !== t) throw new Error(`Workflow context field "${k}" must be ${t}`);
  }
}
