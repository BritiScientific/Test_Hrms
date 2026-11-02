-- =============================================================================
-- 000 — Cluster-level bootstrap. Run ONCE per environment as a superuser.
--
--   hrms_owner  : owns all objects, runs migrations. BYPASSRLS so migrations,
--                 SECURITY DEFINER auth helpers and ledger triggers work.
--                 NEVER used by the running API.
--   hrms_app    : the API's runtime login. NOT owner, NOT superuser,
--                 NOBYPASSRLS -> every query is subject to RLS.
--   hrms_worker : outbox dispatcher. Can read/update outbox_events across
--                 tenants and nothing else.
-- Passwords here are placeholders; set real ones from your secret manager.
-- =============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_owner') THEN
    CREATE ROLE hrms_owner LOGIN BYPASSRLS PASSWORD 'change_me_owner';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    CREATE ROLE hrms_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
      PASSWORD 'change_me_app';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_worker') THEN
    CREATE ROLE hrms_worker LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'change_me_worker';
  END IF;
END $$;
