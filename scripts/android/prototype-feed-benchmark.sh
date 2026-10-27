#!/usr/bin/env bash
# Feed gfxinfo benchmark. Usage: --device ID [--rows N] [--package PKG]
#   [--markdown] [--dry-run] [--enforce]
# PROTOTYPE_FEED_BENCH_FRAME overrides the frame harness executable.
set -euo pipefail
export LC_ALL=C
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
die() { echo "prototype-feed-benchmark: $*" >&2; exit 2; }
rows=1000; device=""; package=dev.jasonpearson.automobile.ctrlproxy
markdown=false; dry=false; enforce=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --device|--rows|--package)
      [[ $# -ge 2 && -n "$2" ]] || die "$1 needs a value"
      case "$1" in --device) device="$2" ;; --rows) rows="$2" ;; --package) package="$2" ;; esac
      shift 2 ;;
    --markdown) markdown=true; shift ;;
    --dry-run) dry=true; shift ;;
    --enforce) enforce=true; shift ;;
    --help|-h) sed -n '2,4p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
[[ -n "$device" ]] || $dry || die "--device is required"
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
# The generator validates rows against the imported contract, before invoking the harness.
bun "${ROOT}/scripts/prototype/generate-feed-benchmark-spec.ts" --rows="$rows" --out "$work_dir/spec.json"
args=(--device "${device:-<device>}" --package "$package" --spec "$work_dir/spec.json" --scenarios "${ROOT}/benchmark/prototype-frame/feed-scenarios.json")
$dry && args+=(--dry-run)
frame_status=0
"${PROTOTYPE_FEED_BENCH_FRAME:-${ROOT}/scripts/android/prototype-frame-benchmark.sh}" "${args[@]}" > "$work_dir/output" || frame_status=$?
cat "$work_dir/output"
$dry && exit "$frame_status"
# Parse the harness's key=value protocol, including errors and zero-frame n/a values.
# Missing scenario lines are n/a; capture/CLI failures retain the harness's exit code.
jq -r '.[].name' "${ROOT}/benchmark/prototype-frame/feed-scenarios.json" > "$work_dir/names"
awk -v markdown="$markdown" '
  FNR==NR { names[++count]=$0; next }
  /^scenario=/ {
    delete fields
    for(i=1;i<=NF;i++) { split($i, pair, "="); fields[pair[1]]=pair[2] }
    name=fields["scenario"]; value=fields["p95_ms"]
    p95[name]=(value ~ /^[0-9]+([.][0-9]+)?$/ && !("error" in fields)) ? value : "n/a"
  }
  END {
    if(markdown=="true") print "| Scenario | p95 ms | Target ms | Result |\n| --- | --- | --- | --- |"
    for(i=1;i<=count;i++) {
      name=names[i]; value=(name in p95) ? p95[name] : "n/a"
      result=value=="n/a" ? "n/a" : (value+0 < 16 ? "pass" : "fail")
      if(markdown=="true") printf "| %s | %s | 16 | %s |\n", name,value,result
    }
    for(i=1;i<=count;i++) {
      name=names[i]; value=(name in p95) ? p95[name] : "n/a"
      result=value=="n/a" ? "n/a" : (value+0 < 16 ? "pass" : "fail")
      printf "verdict scenario=%s p95_ms=%s target_ms=16 result=%s\n",name,value,result
      if(result=="fail") failed=1
    }
    exit failed
  }' "$work_dir/names" "$work_dir/output" > "$work_dir/verdicts" && verdict_status=0 || verdict_status=$?
cat "$work_dir/verdicts"
[[ "$frame_status" -eq 0 ]] || exit "$frame_status"
if $enforce; then exit "$verdict_status"; fi
