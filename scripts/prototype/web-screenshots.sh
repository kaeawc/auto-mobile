#!/usr/bin/env bash
# Run the opt-in headless Chromium screenshot check of the prototype web page's
# reference specs (#16346).
#
#   bash scripts/prototype/web-screenshots.sh            # compare against the goldens
#   bash scripts/prototype/web-screenshots.sh --update   # rewrite the goldens
#
# The integration lane discovers the test but skips it; this runner enables it.
# It needs a Chromium that the pinned playwright-core can launch: install it once
# with `node_modules/.bin/playwright-core install --only-shell chromium` (add
# --with-deps on a fresh Linux host). On a mismatch the actual screenshots and
# pixel diffs land in AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_OUT (default
# scratch/prototype-web-screenshots).

set -euo pipefail

readonly TEST_FILE="test/features/prototype/web/webScreenshots.integration.test.ts"

usage() {
  cat <<'EOF'
Usage: scripts/prototype/web-screenshots.sh [--update] [--help]

Renders the prototype web renderer's reference specs in headless Chromium and
compares each screenshot with its golden under
test/fixtures/prototype-web/screenshots/. --update rewrites the goldens instead.
EOF
}

update=0
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --update) update=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'web-screenshots: unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"

AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS=1 \
  AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_UPDATE="${update}" \
  exec bun test "${TEST_FILE}"
