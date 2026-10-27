#!/usr/bin/env bash
# Report the jobs two workflow files share and how much of each job body is identical (#11872).
#
#   scripts/ci/workflow-duplication-report.sh [A.yml B.yml]
#
# Default: .github/workflows/pull_request.yml against .github/workflows/merge.yml. For each shared
# job id it prints: id, lines in A, lines in B, lines present in both (order-insensitive, comments
# and blanks ignored, `needs:`/`if:` gating counted as differences), and the shared percentage of
# the larger body. A job that only calls a reusable workflow or composite action shows low numbers.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
a="${1:-$root/.github/workflows/pull_request.yml}"
b="${2:-$root/.github/workflows/merge.yml}"

for file in "$a" "$b"; do
  if [[ ! -f "$file" ]]; then
    echo "workflow-duplication-report: no such file: $file" >&2
    exit 2
  fi
done
if ! command -v yq >/dev/null 2>&1; then
  echo "workflow-duplication-report: yq is required" >&2
  exit 2
fi

job_ids() { yq '.jobs | keys | .[]' "$1" | sort; }

body() {
  # Normalized body: comments and blank lines dropped by yq's re-emit, one trimmed line per row.
  yq ".jobs.\"$2\"" "$1" | sed -E 's/^[[:space:]]+//' | grep -v '^$' || true
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

shared="$(comm -12 <(job_ids "$a") <(job_ids "$b"))"
printf '%-34s %6s %6s %7s %7s\n' "job" "A" "B" "shared" "pct"
total=0
while IFS= read -r id; do
  [[ -n "$id" ]] || continue
  body "$a" "$id" | sort >"$tmp/a"
  body "$b" "$id" | sort >"$tmp/b"
  la="$(wc -l <"$tmp/a" | tr -d ' ')"
  lb="$(wc -l <"$tmp/b" | tr -d ' ')"
  common="$(comm -12 "$tmp/a" "$tmp/b" | wc -l | tr -d ' ')"
  larger=$((la > lb ? la : lb))
  pct=0
  if ((larger > 0)); then
    pct=$((common * 100 / larger))
  fi
  printf '%-34s %6s %6s %7s %6s%%\n' "$id" "$la" "$lb" "$common" "$pct"
  total=$((total + 1))
done <<<"$shared"
echo "shared jobs: $total"
