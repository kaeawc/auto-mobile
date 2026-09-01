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
  affects_unit_tests=false
  for file in ${changed_files[@]+"${changed_files[@]}"}; do
    if [[ "$file" == src/* ]]; then
      affects_unit_tests=true
    elif [[ "$file" == test/*.ts && "$file" != *.test.ts ]]; then
      # Shared fakes, fixtures, and test harnesses can slow every importing
      # unit test even though they are not test files themselves.
      affects_unit_tests=true
    fi
  done

  if [[ "$affects_unit_tests" == "true" ]]; then
    # The budget measures test work, not CPU contention from unrelated tests.
    # Keep Bun's source-affected selection, but serialize its execution.
    echo "Source changes detected; measuring Bun-affected unit tests."
    AUTOMOBILE_UNIT_JUNIT_DIR="$report_dir" \
      AUTOMOBILE_UNIT_TEST_WORKERS=1 \
      AUTOMOBILE_UNIT_TEST_BASE_REF="$BUN_TEST_TIMING_BASE_REF" \
      bash scripts/test-ts.sh changed
    # Bun reports a test's elapsed time while every source-affected file shares
    # one runtime. Its occasional GC/module-load pauses are charged to whichever
    # test happens to be active, even though the test itself is fast in the
    # isolated unit-lane environment. Re-run only provisional offenders, one
    # test per fresh process, before enforcing the per-test budget; the initial
    # changed run still executes every dependency-affected test and fails on
    # behavior.
    isolated_count=0
    while IFS=$'\t' read -r file test_name; do
      if [[ -z "$file" || -z "$test_name" ]]; then
        continue
      fi
      escaped_test_name="$(printf '%s' "$test_name" | sed 's/[][\\.^$*+?{}|()]/\\&/g')"
      bun test \
        --isolate \
        --timeout "${AUTOMOBILE_TEST_TIMEOUT_MS:-5000}" \
        --reporter junit \
        --reporter-outfile "$report_dir/isolation-${isolated_count}.xml" \
        "$file" \
        --test-name-pattern "$escaped_test_name"
      isolated_count=$((isolated_count + 1))
    done < <(
      awk -v limit_ms="$max_ms" '
      function attr(rec, key,    pattern, start, len) {
        pattern = key "=\"[^\"]*\""
        if (match(rec, pattern)) {
          start = RSTART + length(key) + 2
          len = RLENGTH - length(key) - 3
          return substr(rec, start, len)
        }
        return ""
      }
      function decode_xml(value) {
        gsub(/&amp;/, sprintf("%c", 38), value)
        gsub(/&quot;/, "\"", value)
        gsub(/&apos;/, sprintf("%c", 39), value)
        gsub(/&lt;/, "<", value)
        gsub(/&gt;/, ">", value)
        return value
      }
      /<testsuite/ {
        candidate = attr($0, "file")
        if (candidate != "") {
          current_file = candidate
        }
      }
      /<testcase/ {
        test_name = decode_xml(attr($0, "name"))
        if (current_file != "" && test_name != "" && attr($0, "time") * 1000.0 > limit_ms) {
          offenders[current_file SUBSEP test_name] = 1
        }
      }
      END {
        for (key in offenders) {
          split(key, parts, SUBSEP)
          print parts[1] "\t" parts[2]
        }
      }
      ' "$report_dir/changed.xml" | sort
    )
    if [[ "$isolated_count" -gt 0 ]]; then
      rm "$report_dir/changed.xml"
    fi
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
    len = RLENGTH - length(key) - 3
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
