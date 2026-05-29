#!/usr/bin/env bash
# Apply pending Supabase SQL migrations, tracked in public.schema_migrations.
#
# Idempotent: each file in supabase/migrations/ runs at most once, in filename
# order, inside its own transaction. Safe to run on every deploy. Designed to
# need no tooling on the host beyond Docker — psql runs in a throwaway
# postgres:16-alpine container.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$REPO_DIR/supabase/migrations"
PSQL_IMAGE="postgres:16-alpine"

# Everything up to AND INCLUDING this file was applied by hand before migration
# tracking existed (the original KPFK deploy). On the first run — when the
# tracking table is empty — these are recorded as already-applied rather than
# re-executed, because the older migrations are not idempotent (e.g. 014_rls
# CREATEs policies unconditionally). Later files (012+ that are still pending,
# and anything new) are applied normally.
BASELINE_THROUGH="011_fix_ghost_transcribed_episodes.sql"

# Resolve DATABASE_URL: explicit env wins; otherwise read it out of the same
# .env that docker compose uses. We extract just this one key rather than
# sourcing the whole file, so other entries can't break the shell.
if [ -z "${DATABASE_URL:-}" ] && [ -f "$REPO_DIR/.env" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$REPO_DIR/.env" | tail -n1 | cut -d= -f2-)"
  DATABASE_URL="${DATABASE_URL%\"}"; DATABASE_URL="${DATABASE_URL#\"}"
  DATABASE_URL="${DATABASE_URL%\'}"; DATABASE_URL="${DATABASE_URL#\'}"
  export DATABASE_URL
fi

if [ -z "${DATABASE_URL:-}" ]; then
  cat >&2 <<'EOF'
✗ DATABASE_URL is not set.

  Add the Supabase Postgres connection string to /root/qir/.env, e.g.:

    DATABASE_URL=postgresql://postgres:<PASSWORD>@db.czjhwhfqohpmwprhasve.supabase.co:5432/postgres?sslmode=require

  Find it in Supabase -> Project Settings -> Database -> Connection string (URI).
  Use the DIRECT connection (port 5432), not the transaction pooler, so the
  transactional DDL in each migration works.
EOF
  exit 1
fi

# psql reading SQL from stdin, with the migrations dir mounted read-only so
# \i /migrations/<file> works inside the container.
psql_stdin() {
  docker run --rm -i \
    -v "$MIGRATIONS_DIR":/migrations:ro \
    "$PSQL_IMAGE" \
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --quiet -f -
}

# Single scalar/column query -> stdout (tuples-only, unaligned).
psql_query() {
  docker run --rm -i \
    "$PSQL_IMAGE" \
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA -c "$1"
}

echo "-> Ensuring migration tracking table (public.schema_migrations)..."
psql_stdin <<'SQL'
create table if not exists public.schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);
SQL

# First-ever run: baseline the pre-tracking migrations as already applied.
applied_count="$(psql_query "select count(*) from public.schema_migrations;")"
if [ "$applied_count" = "0" ]; then
  echo "-> First run: baselining migrations through $BASELINE_THROUGH as already applied..."
  for path in "$MIGRATIONS_DIR"/*.sql; do
    f="$(basename "$path")"
    psql_query "insert into public.schema_migrations(filename) values ('$f') on conflict do nothing;" >/dev/null
    [ "$f" = "$BASELINE_THROUGH" ] && break
  done
fi

# Apply anything not yet recorded, in filename order.
applied="$(psql_query "select filename from public.schema_migrations;")"
pending=0
for path in "$MIGRATIONS_DIR"/*.sql; do
  f="$(basename "$path")"
  if grep -qxF "$f" <<<"$applied"; then
    continue
  fi
  pending=$((pending + 1))
  echo "-> Applying $f ..."
  # One transaction: the migration body and its bookkeeping row commit together,
  # so a failure leaves nothing half-recorded.
  {
    printf 'begin;\n'
    printf '\\i /migrations/%s\n' "$f"
    printf "insert into public.schema_migrations(filename) values ('%s');\n" "$f"
    printf 'commit;\n'
  } | psql_stdin
done

if [ "$pending" -eq 0 ]; then
  echo "OK: database up to date - no pending migrations."
else
  echo "OK: applied $pending migration(s)."
fi
