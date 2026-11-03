#!/usr/bin/env bash
# Run the opt-in headless Chromium screenshot checks of the prototype web page's
# reference specs (#16346) and of the chromeless web still against the Android
# renderer's goldens (#16534).
#
#   bash scripts/prototype/web-screenshots.sh            # compare against the goldens
#   bash scripts/prototype/web-screenshots.sh --update   # rewrite the web goldens and
#                                                        # lower the Android parity budgets
#   bash scripts/prototype/web-screenshots.sh --update --allow-grow
#                                                        # ...and let a parity budget rise
#
# The integration lane discovers the test but skips it; this runner enables it.
# It needs a Chromium that the pinned playwright-core can launch: install it once
# with `node_modules/.bin/playwright-core install --only-shell chromium` (add
# --with-deps on a fresh Linux host). On a mismatch the actual screenshots and
# pixel diffs land in AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_OUT (default
# scratch/prototype-web-screenshots).

set -euo pipefail

readonly TEST_FILES=(
  "test/features/prototype/web/webScreenshots.integration.test.ts"
  "test/features/prototype/web/webAndroidParity.integration.test.ts"
)

usage() {
  cat <<'EOF'
Usage: scripts/prototype/web-screenshots.sh [--update [--allow-grow]] [--help]

Renders the prototype web renderer's reference specs in headless Chromium and
compares each screenshot with its golden under
test/fixtures/prototype-web/screenshots/. It also renders each spec that has an
Android golden chromeless and fails when it differs from that golden in more
pixels than its budget in test/fixtures/prototype-web/android-parity-budgets.json.

--update rewrites the web goldens and lowers each parity budget to what was
measured. A budget only rises with --allow-grow.
EOF
}

update=0
allow_grow=0
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --update) update=1 ;;
    --allow-grow) allow_grow=1 ;;
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

if [[ "${allow_grow}" == "1" && "${update}" != "1" ]]; then
  printf 'web-screenshots: --allow-grow needs --update\n' >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"

AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS=1 \
  AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_UPDATE="${update}" \
  AUTOMOBILE_PROTOTYPE_WEB_PARITY_ALLOW_GROW="${allow_grow}" \
  exec bun test "${TEST_FILES[@]}"
