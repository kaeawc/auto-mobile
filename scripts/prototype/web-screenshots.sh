#!/usr/bin/env bash
# Run the opt-in headless browser check of the prototype web page's reference
# specs (#16346) in Chromium, Firefox and WebKit (#16459), and the
# web still against Android and iOS renderer goldens in Chromium (#16534, #16535),
# and un-padded inlined image boxes against their layout golden in Chromium (#17716).
#
#   bash scripts/prototype/web-screenshots.sh                    # every engine
#   bash scripts/prototype/web-screenshots.sh --engine chromium  # only Chromium
#   bash scripts/prototype/web-screenshots.sh --update           # rewrite the web goldens
#                                                                # and lower the parity budgets
#   bash scripts/prototype/web-screenshots.sh --update --allow-grow
#                                                                # ...and let a parity budget rise
#
# The integration lane discovers the tests but skips them; this runner enables
# them. Every engine runs the behavioural assertions; only Chromium is compared
# with (or, with --update, rewrites) the goldens, and only Chromium runs the
# Android and iOS parity checks. It needs the browsers the pinned playwright-core can
# launch: install them once with
# `node_modules/.bin/playwright-core install --only-shell chromium firefox webkit`
# (add --with-deps on a fresh Linux host). On a mismatch the actual screenshots
# and pixel diffs land in AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_OUT (default
# scratch/prototype-web-screenshots); Firefox and WebKit captures go to its
# firefox/ and webkit/ subdirectories, Android and iOS parity captures to android-parity/ and ios-parity/.

set -euo pipefail

readonly PAGE_TEST="test/features/prototype/web/webScreenshots.integration.test.ts"
readonly IOS_PARITY_TEST="test/features/prototype/web/webIosParity.integration.test.ts"
readonly PARITY_TEST="test/features/prototype/web/webAndroidParity.integration.test.ts"
readonly IMAGE_LAYOUT_TEST="test/features/prototype/web/webImageLayout.integration.test.ts"

usage() {
  cat <<'EOF'
Usage: scripts/prototype/web-screenshots.sh [--engine NAME]... [--update [--allow-grow]] [--help]

Renders the prototype web renderer's reference specs in headless Chromium,
Firefox and WebKit, checks the page's behaviour in each, and compares each
Chromium screenshot with its golden under
test/fixtures/prototype-web/screenshots/. --engine (chromium, firefox or
webkit; repeatable) limits the run to those engines; the default is all three.

When Chromium runs, it also renders each spec that has an Android golden
chromeless and fails when it differs from that golden in more pixels than its
budget in test/fixtures/prototype-web/android-parity-budgets.json allows.
It also compares the iOS-skinned still with the cropped iPhone 16 viewer goldens
using test/fixtures/prototype-web/ios-parity-budgets.json (Chromium only),
and un-padded inlined image boxes with test/fixtures/prototype-web/image-layout-golden.json.

--update rewrites the web goldens (and the image layout golden) and lowers each parity budget to what was
measured. A budget only rises with --allow-grow.
EOF
}

update=0
allow_grow=0
engines=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --update) update=1 ;;
    --allow-grow) allow_grow=1 ;;
    --engine)
      if [[ "$#" -lt 2 ]]; then
        printf 'web-screenshots: --engine needs a value\n' >&2
        usage >&2
        exit 2
      fi
      case "$2" in
        chromium | firefox | webkit) ;;
        *)
          printf 'web-screenshots: unknown engine: %s\n' "$2" >&2
          usage >&2
          exit 2
          ;;
      esac
      engines="${engines:+${engines},}$2"
      shift
      ;;
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

tests=("${PAGE_TEST}")
if [[ -z "${engines}" || ",${engines}," == *",chromium,"* ]]; then
  tests+=("${PARITY_TEST}" "${IOS_PARITY_TEST}" "${IMAGE_LAYOUT_TEST}")
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"

AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS=1 \
  AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_UPDATE="${update}" \
  AUTOMOBILE_PROTOTYPE_WEB_PARITY_ALLOW_GROW="${allow_grow}" \
  AUTOMOBILE_PROTOTYPE_WEB_ENGINES="${engines}" \
  exec bun test "${tests[@]}"
