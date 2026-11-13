#!/usr/bin/env bash
#
# Regenerate MCP tool definitions for IDE completion and each tool's Requires
# cell in docs/tools.md and on each tool's own page under docs/using/.
#
# Usage:
#   ./scripts/update-tool-definitions.sh
#   ./scripts/update-tool-definitions.sh --no-stage
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required to generate tool definitions." >&2
  exit 1
fi

# Without node_modules, bun silently auto-installs the *latest* zod (4.x) into its
# global cache; prototypeTools then feeds a Zod 3 spec to the Zod 4 converter and the
# hook dies with "Custom types cannot be represented in JSON Schema". Install the
# locked dependency graph first and forbid auto-install so the pinned zod 3 is used.
if [[ ! -f "${PROJECT_ROOT}/node_modules/zod/package.json" ]]; then
  echo "node_modules is missing; running bun install --frozen-lockfile..."
  (cd "${PROJECT_ROOT}" && bun install --frozen-lockfile)
fi

echo "Generating tool definitions..."
(cd "${PROJECT_ROOT}" && bun --no-install scripts/generate-tool-definitions.ts)

# Keep the pre-commit generated output aligned with the repository formatter.
# Otherwise generation after `bun run format` immediately recreates formatting
# drift that the CI formatter gate would reject.
# Only the pages the generator writes (docs/tools.md and each tool's own page), so
# unrelated edits elsewhere in docs/ are never formatted or staged.
# A read loop: macOS system Bash 3.2 has no builtin that reads lines into an array.
TOOL_DOCS=()
while IFS= read -r doc; do TOOL_DOCS+=("$doc"); done < <(cd "${PROJECT_ROOT}" && bun --no-install scripts/generate-tool-definitions.ts --list-docs)
GENERATED=(schemas/tool-definitions.json ${TOOL_DOCS[@]+"${TOOL_DOCS[@]}"})
(cd "${PROJECT_ROOT}" && bunx oxfmt "${GENERATED[@]}")

if [[ "${1:-}" == "--no-stage" ]]; then
  echo "Generated schemas/tool-definitions.json and tool docs without staging."
  exit 0
fi

if git -C "${PROJECT_ROOT}" diff --quiet -- "${GENERATED[@]}"; then
  echo "schemas/tool-definitions.json and tool docs are up to date."
  exit 0
fi

git -C "${PROJECT_ROOT}" add -- "${GENERATED[@]}"
echo "Updated and staged schemas/tool-definitions.json and tool docs."
