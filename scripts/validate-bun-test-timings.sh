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
    case "$file" in
      src/*|package.json|bun.lock|bunfig.toml|scripts/test-ts.sh|scripts/validate-bun-test-timings.sh)
        # Runtime inputs can change test loading, preloads, or scheduling for
        # every unit test even when no test file itself changed.
        affects_unit_tests=true
        ;;
      test/*.ts)
        # Shared fakes, fixtures, and test harnesses can slow every importing
        # unit test even though they are not test files themselves.
        if [[ "$file" != *.test.ts ]]; then
          affects_unit_tests=true
        fi
        ;;
    esac
  done

  if [[ "$affects_unit_tests" == "true" ]]; then
    source_report_dir="${BUN_TEST_TIMING_REPORT_DIR:-}"
    reused_unit_reports=false
    if [[ -n "$source_report_dir" ]]; then
      has_source_report=false
      for source_report in "$source_report_dir"/*.xml; do
        if [[ -f "$source_report" ]]; then
          has_source_report=true
          break
        fi
      done
      if [[ "$has_source_report" != "true" ]]; then
        echo "No unit-lane JUnit reports found in ${source_report_dir}." >&2
        exit 1
      fi
      # The complete unit lane already ran in isolated shards. Reuse its
      # reports rather than asking Bun's broad --changed graph walk to run the
      # same hundreds of tests a second time.
      echo "Source changes detected; measuring complete unit-lane reports."
      report_dir="$source_report_dir"
      reused_unit_reports=true
    else
      echo "Source changes detected; measuring Bun-affected unit tests."
      AUTOMOBILE_UNIT_JUNIT_DIR="$report_dir" \
        AUTOMOBILE_UNIT_TEST_WORKERS=3 \
        AUTOMOBILE_UNIT_TEST_BASE_REF="$BUN_TEST_TIMING_BASE_REF" \
        bash scripts/test-ts.sh changed
    fi
    # A parallel shard can charge occasional GC/module-load pauses to whichever
    # test happens to be active. Re-run only provisional offenders, one test
    # per fresh process, before enforcing the per-test budget; the complete
    # unit lane has already exercised every dependency-affected test.
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
      ' "$report_dir"/*.xml | sort
    )
    if [[ "$isolated_count" -gt 0 ]]; then
      if [[ "$reused_unit_reports" == "true" ]]; then
        rm -f "$report_dir"/shard-*.xml
      else
        rm -f "$report_dir/changed.xml"
      fi
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
