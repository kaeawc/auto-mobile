#!/usr/bin/env bash
set -euo pipefail

report_path="${1:-scratch/bun-test-report.xml}"
report_dir="${report_path%.xml}.d"
max_ms="${BUN_TEST_MAX_MS:-100}"

mkdir -p "$(dirname "$report_path")"

if [[ -n "${BUN_TEST_TIMING_BASE_REF:-}" ]]; then
  rm -rf "$report_dir"
  mkdir -p "$report_dir"
  changed_files=()
  while IFS= read -r file; do
    changed_files+=("$file")
  done < <(
    {
      git diff --name-only --diff-filter=ACMR "${BUN_TEST_TIMING_BASE_REF}...HEAD"
      git diff --name-only --diff-filter=ACMR
      git ls-files --others --exclude-standard
    } | sort -u
  )

  changed_count=0
  source_changed=false
  for file in ${changed_files[@]+"${changed_files[@]}"}; do
    if [[ "$file" == src/* ]]; then
      source_changed=true
    fi
  done

  if [[ "$source_changed" == "true" ]]; then
    echo "Source changes detected; measuring the complete unit suite."
    AUTOMOBILE_UNIT_JUNIT_DIR="$report_dir" bash scripts/test-ts.sh unit
    changed_count=1
  else
    for file in ${changed_files[@]+"${changed_files[@]}"}; do
    case "$file" in
      test/*.test.ts)
        if [[ "$file" != *.integration.test.ts && "$file" != test/stress/* && -f "$file" ]]; then
          bun test \
            --isolate \
            --timeout "${AUTOMOBILE_TEST_TIMEOUT_MS:-5000}" \
            --reporter junit \
            --reporter-outfile "$report_dir/changed-${changed_count}.xml" \
            "$file"
          changed_count=$((changed_count + 1))
        fi
        ;;
    esac
    done
  fi

  if [[ "$changed_count" -eq 0 ]]; then
    echo "No changed unit tests to validate against the ${max_ms}ms budget."
    exit 0
  fi
else
  AUTOMOBILE_UNIT_JUNIT_DIR="$report_dir" bash scripts/test-ts.sh unit
fi

set -- "$report_dir"/*.xml
if [[ ! -f "$1" ]]; then
  echo "No JUnit shard reports found in ${report_dir}." >&2
  exit 1
fi

awk -v limit_ms="$max_ms" '
function attr(rec, key,    pattern, start, len) {
  pattern = key "=\"[^\"]*\""
  if (match(rec, pattern)) {
    start = RSTART + length(key) + 2
    len = RLENGTH - length(key) - 2
    return substr(rec, start, len)
  }
  return ""
}
BEGIN {
  fail = 0
  count = 0
}
{
  if ($0 ~ /<testcase/) {
    count += 1
    name = attr($0, "name")
    class = attr($0, "classname")
    time_str = attr($0, "time")
    if (time_str == "") {
      next
    }
    time_ms = time_str * 1000.0
    if (time_ms > limit_ms) {
      if (class != "" && name != "") {
        label = class "." name
      } else if (name != "") {
        label = name
      } else {
        label = "(unknown)"
      }
      printf "Test exceeded %dms: %s (%.2fms)\n", limit_ms, label, time_ms > "/dev/stderr"
      fail = 1
    }
  }
}
END {
  if (count == 0) {
    print "No testcases found in junit report." > "/dev/stderr"
    exit 1
  }
  exit fail
}
' "$@"
