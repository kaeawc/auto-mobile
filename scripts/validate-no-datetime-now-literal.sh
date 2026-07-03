#!/usr/bin/env bash
#
# Guard against a SQL time-expression column default being passed as a plain
# string in migrations.
#
# `col.defaultTo("datetime('now')")` (or `"CURRENT_TIMESTAMP"`) passes a plain
# string to Kysely, which binds it as a VALUE — the DDL becomes
# DEFAULT 'datetime(''now'')' / DEFAULT 'CURRENT_TIMESTAMP', so any defaulted row
# stores the literal text instead of an evaluated timestamp. The correct form is
# defaultTo(sql`(datetime('now'))`). This check fails CI if the broken pattern
# returns for any SQL-time expression (not just the two that triggered #2895).
#
# See issue #2895 (48 datetime('now') columns + 1 CURRENT_TIMESTAMP column stored
# the literal string across 25 migrations).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="${ROOT_DIR}/src/db/migrations"

# Match `defaultTo("<sql-time-expr>...")` where the string literal opens with a
# SQL date/time function or CURRENT_* keyword — the shape that binds as a value
# instead of raw SQL. Legitimate value defaults ("{}", "", "success") do not
# match. The correct sql`...`-tagged form is not a string literal, so it is
# excluded. Case-insensitive so CURRENT_TIMESTAMP / current_timestamp both trip.
PATTERN="defaultTo\\(\\s*[\"'](datetime\\(|strftime\\(|date\\(|time\\(|julianday\\(|unixepoch\\(|CURRENT_TIMESTAMP|CURRENT_TIME|CURRENT_DATE)"

matches="$(grep -rEni --include='*.ts' "$PATTERN" "$MIGRATIONS_DIR" || true)"

if [[ -n "$matches" ]]; then
  echo "error: SQL time-expression passed as a string literal to defaultTo(...) in migrations — use defaultTo(sql\`(<expr>)\`) so SQLite evaluates it instead of storing the literal text:" >&2
  echo "$matches" >&2
  exit 1
fi

echo "No string-literal SQL time-expression defaults found in migrations."
