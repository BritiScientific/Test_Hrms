#!/usr/bin/env bash
# Recreate the dev database, apply migrations as hrms_owner, load the seed.
# Usage: PGHOST=localhost PGSUPERUSER=postgres ./scripts/reset-db.sh
set -euo pipefail
DB=${PGDATABASE:-hrms}
SU=${PGSUPERUSER:-postgres}
HOST=${PGHOST:-localhost}
DIR="$(cd "$(dirname "$0")/.." && pwd)"
psql -v ON_ERROR_STOP=1 -h "$HOST" -U "$SU" -d postgres -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)"
psql -v ON_ERROR_STOP=1 -h "$HOST" -U "$SU" -d postgres -q -f "$DIR/db/migrations/000_bootstrap_roles.sql"
psql -v ON_ERROR_STOP=1 -h "$HOST" -U "$SU" -d postgres -q -c "CREATE DATABASE $DB OWNER hrms_owner"
psql -v ON_ERROR_STOP=1 -h "$HOST" -U "$SU" -d "$DB" -q -c "REVOKE CREATE ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO hrms_owner"
for f in "$DIR"/db/migrations/00[1-9]_*.sql; do
  echo "applying $(basename "$f")"
  PGPASSWORD=${OWNER_PASSWORD:-change_me_owner} psql -v ON_ERROR_STOP=1 -h "$HOST" -U hrms_owner -d "$DB" -q -f "$f"
done
if [ "${SEED:-1}" = "1" ]; then
  PGPASSWORD=${OWNER_PASSWORD:-change_me_owner} psql -v ON_ERROR_STOP=1 -h "$HOST" -U hrms_owner -d "$DB" -q -f "$DIR/db/seed/dev_seed.sql"
  echo "seeded"
fi
