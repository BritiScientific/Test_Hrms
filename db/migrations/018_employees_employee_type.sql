-- =============================================================================
-- 018 — Work Schedule Configuration: link employees to an employee type
--   * One additive, nullable column. No existing column or constraint changes,
--     so nothing that reads employees today is affected until the API is wired.
--   * The link lives on employees, not users: users is global (one email can
--     belong to several tenants) while a type is tenant-owned, so a column
--     there would leak across tenants and sit outside RLS.
--   * The FK is composite (tenant_id, employee_type_id) -> employee_types
--     (tenant_id, id), which makes a cross-tenant reference impossible.
--   * Added NOT VALID, then backfilled, then VALIDATEd, so employees is never
--     held under an ACCESS EXCLUSIVE lock for a full table scan.
--   * The column stays nullable: a row the backfill could not match keeps
--     working and the UI falls back to the legacy employment_type label.
-- =============================================================================

ALTER TABLE employees ADD COLUMN employee_type_id bigint;

ALTER TABLE employees ADD CONSTRAINT fk_employees_employee_type
  FOREIGN KEY (tenant_id, employee_type_id) REFERENCES employee_types(tenant_id, id)
  NOT VALID;

-- Every employee gets the default type whose base_category equals the legacy
-- employment_type. Lowest id wins, so the result does not depend on row order
-- if a tenant has already added a second type with the same base category.
UPDATE employees e
   SET employee_type_id = pick.id
  FROM (
    SELECT DISTINCT ON (tenant_id, base_category) tenant_id, base_category, id
      FROM employee_types
     WHERE is_active
     ORDER BY tenant_id, base_category, id
  ) pick
 WHERE pick.tenant_id = e.tenant_id
   AND pick.base_category = e.employment_type
   AND e.employee_type_id IS NULL;

ALTER TABLE employees VALIDATE CONSTRAINT fk_employees_employee_type;

-- Dev builds a plain index inside the transaction. On a large production
-- employees table, create it separately with CREATE INDEX CONCURRENTLY
-- (outside a transaction) and skip this statement.
CREATE INDEX idx_employees_employee_type ON employees (tenant_id, employee_type_id);

-- Verification (run by hand after migrating; both must return 0 rows):
--   SELECT count(*) FROM employees WHERE employee_type_id IS NULL AND status <> 'exited';
--   SELECT count(*) FROM employees e JOIN employee_types et
--     ON et.tenant_id = e.tenant_id AND et.id = e.employee_type_id
--    WHERE et.base_category <> e.employment_type;
