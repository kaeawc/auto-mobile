#!/usr/bin/env bash
# Publish the complete PR-only time-to-green report (#11582), read-only.
# Environment:
#   TTG_SINCE            window as Nd or Nh (default 24h)
#   TTG_MAX_API_CALLS    positive API budget, at most 1000 (default 600)
#   TTG_OUT_DIR          published files (default RUNNER_TEMP/TMPDIR/ci-time-to-green-report)
#   GITHUB_STEP_SUMMARY  optional job summary destination
#   GITHUB_REPOSITORY    optional owner/repo passed to the tool
#   TTG_BUN              Bun executable (default bun); test seam
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
since="${TTG_SINCE:-24h}"
budget="${TTG_MAX_API_CALLS:-600}"
out="${TTG_OUT_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ci-time-to-green-report}"
bun="${TTG_BUN:-bun}"

if [[ ! "$since" =~ ^[0-9]+[dh]$ ]]; then
  echo 'TTG_SINCE must be a window as Nd or Nh.' >&2
  exit 2
fi
# Bound the number without shell arithmetic (including overflow or octal interpretation).
if [[ ! "$budget" =~ ^0*([1-9][0-9]{0,2}|1000)$ ]]; then
  echo 'TTG_MAX_API_CALLS must be a positive integer at most 1000.' >&2
  exit 2
fi

mkdir -p "$out"
# Use the tool runtime's os.tmpdir() for cache/bundle writes, falling back for test stubs.
tmp_root="$("$bun" -e 'process.stdout.write(require("node:os").tmpdir())')" || tmp_root=''
tmp_root="${tmp_root:-${TMPDIR:-/tmp}}"
work="$(mktemp -d "$tmp_root/ci-time-to-green.XXXXXX")"
trap 'rm -rf "$work"' EXIT
markdown="$out/time-to-green.md"
json="$out/time-to-green.json"
bundle="$out/time-to-green-bundle.json"
rm -f "$markdown" "$json" "$bundle"

publication_failed() {
  local code="$1" meaning
  case "$code" in
    3) meaning='GitHub API failure' ;;
    4) meaning='stopped on the API call budget or a rate limit' ;;
    *) meaning='unexpected failure' ;;
  esac
  rm -f "$markdown" "$json" "$bundle"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '\n## Time-to-green publication failed (%s)\n\nExit code %s: %s; no report was published for this window.\n' \
      "$since" "$code" "$meaning" >> "$GITHUB_STEP_SUMMARY"
  fi
  echo "::error::Time-to-green exit code $code: $meaning; no report was published for this window ($since)." >&2
  exit "$code"
}

cd "$repo_root"
args=(scripts/ci/ci-time-to-green.ts --since "$since" --pr-runs-only
  --max-api-calls "$budget" --cache-dir "$work/cache" --save-bundle "$work/bundle.json")
if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
  args+=(--repo "$GITHUB_REPOSITORY")
fi
set +e
"$bun" "${args[@]}" > "$markdown"
code=$?
set -e
if [[ "$code" -ne 0 ]]; then
  publication_failed "$code"
fi
if [[ ! -s "$markdown" ]]; then
  publication_failed 1
fi

set +e
"$bun" scripts/ci/ci-time-to-green.ts --from-bundle "$work/bundle.json" --json > "$json"
code=$?
set -e
if [[ "$code" -ne 0 ]]; then
  publication_failed "$code"
fi
if [[ ! -s "$json" || ! -s "$work/bundle.json" ]]; then
  publication_failed 1
fi
cp "$work/bundle.json" "$bundle"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '\n## PR time-to-green report: %s, pull_request runs only, generated %s\n\n' \
    "$since" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$GITHUB_STEP_SUMMARY"
  cat "$markdown" >> "$GITHUB_STEP_SUMMARY"
fi
cat "$markdown"
