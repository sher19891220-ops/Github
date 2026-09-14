#!/usr/bin/env bash
# Rebuilds the entire ledger from the operator's source files, in order.
#
# The point of this script is that the P&L is REPRODUCIBLE. Before it
# existed, revenue and the expenses sheet had been posted by hand with
# commands nobody kept, so a clean database could not be brought back to the
# state the dashboard was reporting. A figure you cannot rebuild is a figure
# you cannot defend.
#
# None of the source files live in this repository — they carry unit
# numbers, driver names, addresses and worse. They are read from a directory
# you point this at.
#
#   scripts/rebuild-ledger.sh <source-dir> <from> <to> [--apply]
#
# Without --apply every step reports what it would do and writes nothing to
# the ledger. Staging rows ARE written, because staging is the review area,
# not the books.
set -euo pipefail

SRC="${1:?Usage: rebuild-ledger.sh <source-dir> <from:YYYY-MM-DD> <to:YYYY-MM-DD> [--apply]}"
FROM="${2:?missing <from>}"
TO="${3:?missing <to>}"
APPLY="${4:-}"
BY="${OPSDASH_ASSERTED_BY:-rebuild}"
: "${DATABASE_URL:?DATABASE_URL must be set}"

step() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

step "1/8  schema — apply any pending migrations"
npx tsx scripts/migrate.ts

step "2/8  reference data (entities, chart of accounts)"
npx tsx scripts/seed-reference.ts

step "3/8  truck roster -> effective-dated carrier history"
npx tsx scripts/load-truck-roster.ts tests/fixtures/real/truck-entity-roster.csv

step "4/8  fixed-cost rate card"
npx tsx scripts/load-fixed-cost-rates.ts tests/fixtures/real/fixed-cost-rate-card.csv "$FROM"

step "5/8  revenue — dispatch sheet, through the upload path"
npx tsx scripts/load-document.ts revenue "$SRC/dispatch2026.txt" "$BY" $APPLY

step "6/8  toll & maintenance — expenses sheet, through the upload path"
npx tsx scripts/load-document.ts maintenance "$SRC/expenses.txt" "$BY" $APPLY

step "7/8  unattributed trailer cost -> split across the carriers"
npx tsx scripts/consolidate-trailer-cost.ts "$FROM" "$TO" "$BY" $APPLY

step "8/8  modelled cost — rate card, then company driver pay"
npx tsx scripts/post-fixed-costs.ts "$FROM" "$TO" "$BY" $APPLY
npx tsx scripts/post-driver-pay.ts "$FROM" "$TO" 65 "$BY" "$SRC/dispatch2026.txt" $APPLY

printf '\n\033[1mNOT posted by this script:\033[0m fuel (waiting on the vendor statement)\n'
printf 'and owner-operator pay (waiting on the deduction side of the lease terms).\n'
printf 'Every margin this produces is a CEILING until those two land.\n'
