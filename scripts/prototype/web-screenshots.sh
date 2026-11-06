#!/usr/bin/env bash
# Run the opt-in headless browser check of the prototype web page's reference
# specs (#16346) in Chromium, Firefox and WebKit (#16459).
#
#   bash scripts/prototype/web-screenshots.sh                    # every engine
#   bash scripts/prototype/web-screenshots.sh --engine chromium  # only Chromium
#   bash scripts/prototype/web-screenshots.sh --update           # rewrite the goldens
#
# The integration lane discovers the test but skips it; this runner enables it.
# Every engine runs the behavioural assertions; only Chromium is compared with
# (or, with --update, rewrites) the goldens. It needs the browsers the pinned
# playwright-core can launch: install them once with
# `node_modules/.bin/playwright-core install --only-shell chromium firefox webkit`
# (add --with-deps on a fresh Linux host). On a mismatch the actual screenshots
# and pixel diffs land in AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_OUT (default
# scratch/prototype-web-screenshots); Firefox and WebKit captures go to its
# firefox/ and webkit/ subdirectories.

set -euo pipefail

readonly TEST_FILE="test/features/prototype/web/webScreenshots.integration.test.ts"

usage() {
  cat <<'EOF'
Usage: scripts/prototype/web-screenshots.sh [--engine NAME]... [--update] [--help]

Renders the prototype web renderer's reference specs in headless Chromium,
Firefox and WebKit, checks the page's behaviour in each, and compares each
Chromium screenshot with its golden under
test/fixtures/prototype-web/screenshots/. --update rewrites the goldens instead.
--engine (chromium, firefox or webkit; repeatable) limits the run to those
engines; the default is all three.
EOF
}

update=0
engines=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --update) update=1 ;;
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

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"

AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS=1 \
  AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_UPDATE="${update}" \
  AUTOMOBILE_PROTOTYPE_WEB_ENGINES="${engines}" \
  exec bun test "${TEST_FILE}"
