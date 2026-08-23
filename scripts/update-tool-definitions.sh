#!/usr/bin/env bash
#
# Regenerate MCP tool definitions for IDE completion.
#
# Usage:
#   ./scripts/update-tool-definitions.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required to generate tool definitions." >&2
  exit 1
fi

echo "Generating tool definitions..."
(cd "${PROJECT_ROOT}" && bun scripts/generate-tool-definitions.ts)

# Keep the pre-commit generated output aligned with the repository formatter.
# Otherwise generation after `bun run format` immediately recreates formatting
# drift that the CI formatter gate would reject.
(cd "${PROJECT_ROOT}" && bunx oxfmt schemas/tool-definitions.json)

if git -C "${PROJECT_ROOT}" diff --quiet -- schemas/tool-definitions.json; then
  echo "schemas/tool-definitions.json is up to date."
  exit 0
fi

git -C "${PROJECT_ROOT}" add schemas/tool-definitions.json
echo "Updated and staged schemas/tool-definitions.json."
