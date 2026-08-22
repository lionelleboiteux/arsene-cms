#!/usr/bin/env bash
# Arsène — idempotent migration deploy.
#
# db/migrations/*.sql is applied by the test harness (tests/support/pg.ts)
# against an always-fresh database, so it has never needed to track which
# migrations already ran. A real deploy target isn't fresh on every run —
# this script tracks applied migrations in a `_migrations_applied` table and
# skips what's already there, so re-running it against an up-to-date database
# is a safe no-op (rehearsed: see pdlc/arsene-cms/10-pipeline.v1.md).
#
# Usage: DATABASE_URL=postgresql://... ./scripts/deploy-migrations.sh
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL must be set" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$SCRIPT_DIR/../db/migrations"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
create table if not exists _migrations_applied (
  filename   text primary key,
  applied_at timestamptz not null default now()
);
SQL

for f in "$MIGRATIONS_DIR"/*.sql; do
  name="$(basename "$f")"
  already=$(psql "$DATABASE_URL" -t -A -c "select 1 from _migrations_applied where filename = '$name'")
  if [ "$already" = "1" ]; then
    echo "skip  $name (already applied)"
    continue
  fi
  echo "apply $name"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
    "insert into _migrations_applied (filename) values ('$name')"
done

echo "migrations up to date"
