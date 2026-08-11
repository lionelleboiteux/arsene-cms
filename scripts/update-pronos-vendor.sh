#!/usr/bin/env bash
# Re-vendor pronos' OpenAPI contract into Arsène, and record the pinned commit.
#
# Run manually (never in CI) — see pdlc/arsene-cms/contracts/pronos-fixtures.consumer.md §6.
set -euo pipefail

PRONOS_REPO="${PRONOS_REPO:-/Users/lionelleboiteux/work/pronos}"
SRC="$PRONOS_REPO/pdlc/jeu-des-pronos/contracts/openapi.yaml"
DEST_DIR="$(cd "$(dirname "$0")/.." && pwd)/pdlc/arsene-cms/contracts/vendor"

[ -f "$SRC" ] || { echo "Not found: $SRC (set PRONOS_REPO)" >&2; exit 1; }

SHA="$(git -C "$PRONOS_REPO" rev-parse HEAD)"
WHEN="$(git -C "$PRONOS_REPO" log -1 --format=%cI)"

cp "$SRC" "$DEST_DIR/pronos-openapi.yaml"

echo "Vendored $SRC"
echo "  commit: $SHA"
echo "  date:   $WHEN"
echo "Update the pinned commit table in $DEST_DIR/PRONOS_SOURCE.md by hand."
