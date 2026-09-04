#!/bin/bash
# Bootstrap a session on this repo: dependencies, import path, and an honest
# statement of whether the source corpus is actually here.
#
# The container is ephemeral and has been reclaimed mid-analysis before, taking
# data/raw with it. data/raw is gitignored (bank statements, payroll), so a
# fresh container has the CODE but none of the DATA -- and analysis scripts then
# fail in ways that look like bugs. The catalog check makes that state visible
# in the first seconds instead of an hour in.
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

python3 -m pip install --quiet --disable-pip-version-check -r requirements.txt 2>&1 \
  | grep -v "Running pip as the 'root' user" || true

echo 'export PYTHONPATH="${PYTHONPATH:+$PYTHONPATH:}.:ingest:analysis"' >> "${CLAUDE_ENV_FILE:-/dev/null}"

echo "--- source corpus ---"
if [ -f data/CATALOG.json ]; then
  # --check exits 1 on any drift; that is information, not a failure.
  python3 ingest/catalog.py --check --no-uploads 2>/dev/null | tail -25 || true
  echo "Catalog: docs/CATALOG.md   (rebuild: python3 ingest/catalog.py)"
else
  echo "No catalog yet -- run: python3 ingest/catalog.py"
fi
