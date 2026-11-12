#!/usr/bin/env bash
#
# Regenerate MCP tool definitions for IDE completion.
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

# Without node_modules, bun silently auto-installs the *latest* zod into its global
# cache, and the generated schemas then depend on whatever version that is. Install the
# locked dependency graph first and forbid auto-install so the pinned zod is used.
if [[ ! -f "${PROJECT_ROOT}/node_modules/zod/package.json" ]]; then
  echo "node_modules is missing; running bun install --frozen-lockfile..."
  (cd "${PROJECT_ROOT}" && bun install --frozen-lockfile)
fi

echo "Generating tool definitions..."
(cd "${PROJECT_ROOT}" && bun --no-install scripts/generate-tool-definitions.ts)

# Keep the pre-commit generated output aligned with the repository formatter.
# Otherwise generation after `bun run format` immediately recreates formatting
# drift that the CI formatter gate would reject.
(cd "${PROJECT_ROOT}" && bunx oxfmt schemas/tool-definitions.json)

if [[ "${1:-}" == "--no-stage" ]]; then
  echo "Generated schemas/tool-definitions.json without staging."
  exit 0
fi

if git -C "${PROJECT_ROOT}" diff --quiet -- schemas/tool-definitions.json; then
  echo "schemas/tool-definitions.json is up to date."
  exit 0
fi

git -C "${PROJECT_ROOT}" add schemas/tool-definitions.json
echo "Updated and staged schemas/tool-definitions.json."
