#!/usr/bin/env bash
#
# Enforce the repository's per-test unit budget ("unit tests pass in 100ms or
# less") against the JUnit reporter's per-test time, which already excludes
# beforeAll/beforeEach fixture work.
#
# A single wall-clock sample on a shared CI runner is not evidence: GC pauses,
# module warm-up, and co-tenant load are charged to whichever test happens to be
# running when they land. Three tests have gone red on a 1-3ms overshoot that
# way (#6286, #6313, #6837). So a provisional offender is never failed on its
# first sample: its whole FILE is re-run in isolation several times and only the
# MEDIAN of those samples is enforced. Re-running the file rather than the
# single test matters — a one-test process charges all of Bun's module and JIT
# warm-up to that test, which is how #6837 measured 101.76ms for a property
# that costs ~3ms once the runtime is warm.
set -euo pipefail

report_path="${1:-scratch/bun-test-report.xml}"
report_dir="${report_path%.xml}.d"
recheck_dir="${report_path%.xml}.recheck.d"
max_ms="${BUN_TEST_MAX_MS:-100}"
recheck_runs="${BUN_TEST_TIMING_RECHECK_RUNS:-3}"
# Beyond a handful of offending files the signal is a real regression rather
# than runner noise, and re-running them all would only burn CI minutes.
recheck_max_files="${BUN_TEST_TIMING_RECHECK_MAX_FILES:-8}"

mkdir -p "$(dirname "$report_path")"

# One TSV row per measured testcase: file, classname, name, milliseconds.
# shellcheck disable=SC2016 # awk program text: $0/$1 are awk fields, not shell.
testcase_rows_awk='
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
  gsub(/&quot;/, "\"", value)
  gsub(/&apos;/, sprintf("%c", 39), value)
  gsub(/&lt;/, "<", value)
  gsub(/&gt;/, ">", value)
  gsub(/&amp;/, sprintf("%c", 38), value)
  return value
}
FNR == 1 {
  current_file = ""
}
/<testsuite/ {
  candidate = attr($0, "file")
  if (candidate != "") {
    current_file = candidate
  }
}
/<testcase/ {
  name = decode_xml(attr($0, "name"))
  time_str = attr($0, "time")
  if (name == "" || time_str == "") {
    next
  }
  printf "%s\t%s\t%s\t%.6f\n", current_file, decode_xml(attr($0, "classname")), name, time_str * 1000.0
}
'

testcase_rows() {
  awk "$testcase_rows_awk" "$@"
}

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
    else
      echo "Source changes detected; measuring Bun-affected unit tests."
      AUTOMOBILE_UNIT_JUNIT_DIR="$report_dir" \
        AUTOMOBILE_UNIT_TEST_WORKERS=3 \
        AUTOMOBILE_UNIT_TEST_BASE_REF="$BUN_TEST_TIMING_BASE_REF" \
        bash scripts/test-ts.sh changed
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

rm -rf "$recheck_dir"
mkdir -p "$recheck_dir"
measured_rows="$recheck_dir/measured.tsv"
offender_rows="$recheck_dir/offenders.tsv"
recheck_rows="$recheck_dir/recheck.tsv"

testcase_rows "$@" > "$measured_rows"
if [[ ! -s "$measured_rows" ]]; then
  echo "No testcases found in junit report." >&2
  exit 1
fi

awk -F'\t' -v limit_ms="$max_ms" '
$4 + 0 > limit_ms && !seen[$1 FS $2 FS $3]++ {
  print $1 "\t" $2 "\t" $3 "\t" $4
}
' "$measured_rows" | sort > "$offender_rows"

if [[ ! -s "$offender_rows" ]]; then
  exit 0
fi

# Distinct files owning a provisional offender. A report without a `file`
# attribute cannot be re-run, so there the first sample stands.
offender_files=()
while IFS= read -r file; do
  offender_files+=("$file")
done < <(cut -f1 "$offender_rows" | grep -v '^$' | sort -u)

: > "$recheck_rows"
offender_file_count="${#offender_files[@]}"
if [[ "$offender_file_count" -gt "$recheck_max_files" ]]; then
  echo "Skipping the median recheck: ${offender_file_count} files exceed the ${max_ms}ms budget, which is a regression rather than runner noise."
elif [[ "$offender_file_count" -gt 0 ]]; then
  echo "Rechecking ${offender_file_count} file(s) over the ${max_ms}ms budget: ${recheck_runs} isolated run(s) each, median enforced."
  recheck_index=0
  for file in ${offender_files[@]+"${offender_files[@]}"}; do
    if [[ ! -f "$file" ]]; then
      continue
    fi
    for ((run = 0; run < recheck_runs; run += 1)); do
      recheck_report="$recheck_dir/recheck-${recheck_index}.xml"
      recheck_index=$((recheck_index + 1))
      # The whole file, so module load and JIT warm-up are amortized the way
      # the real unit lane amortizes them instead of being billed to one test.
      # A failing assertion here is the unit lane's business, not the budget's:
      # report it and keep measuring rather than exiting with a bare status.
      if ! bun test \
        --isolate \
        --timeout "${AUTOMOBILE_TEST_TIMEOUT_MS:-5000}" \
        --reporter junit \
        --reporter-outfile "$recheck_report" \
        "$file"; then
        echo "Recheck run ${run} of ${file} did not pass; measuring whatever it reported." >&2
      fi
      if [[ -f "$recheck_report" ]]; then
        testcase_rows "$recheck_report" >> "$recheck_rows"
      fi
    done
  done
fi

awk -F'\t' -v limit_ms="$max_ms" -v recheck_file="$recheck_rows" -v recheck_runs="$recheck_runs" '
function median(key,    values, count, outer, inner, swap) {
  count = split(samples[key], values, ",")
  for (outer = 1; outer <= count; outer += 1) {
    for (inner = outer + 1; inner <= count; inner += 1) {
      if (values[inner] + 0 < values[outer] + 0) {
        swap = values[outer]
        values[outer] = values[inner]
        values[inner] = swap
      }
    }
  }
  if (count % 2 == 1) {
    return values[(count + 1) / 2] + 0
  }
  return (values[count / 2] + values[count / 2 + 1]) / 2.0
}
FILENAME == recheck_file {
  key = $1 SUBSEP $2 SUBSEP $3
  samples[key] = (key in samples) ? samples[key] "," $4 : $4
  runs[key] += 1
  next
}
{
  key = $1 SUBSEP $2 SUBSEP $3
  label = ($2 != "" && $3 != "") ? $2 "." $3 : $3
  if (key in samples) {
    # A recheck run can die before the reporter writes this testcase, and a
    # median over the survivors is not the evidence the gate asked for: one fast
    # sample would clear a real breach. Fewer samples than configured means the
    # recheck did not happen, so the first measurement stands.
    if (runs[key] < recheck_runs + 0) {
      printf "Test exceeded %dms: %s (%.2fms; recheck produced %d of %d isolated samples)\n", limit_ms, label, $4, runs[key], recheck_runs > "/dev/stderr"
      fail = 1
      next
    }
    effective = median(key)
    if (effective > limit_ms) {
      printf "Test exceeded %dms: %s (median %.2fms of %d isolated runs)\n", limit_ms, label, effective, runs[key] > "/dev/stderr"
      fail = 1
    } else {
      printf "Recheck cleared %s: median %.2fms over %d isolated runs (first sample %.2fms).\n", label, effective, runs[key], $4
    }
    next
  }
  printf "Test exceeded %dms: %s (%.2fms)\n", limit_ms, label, $4 > "/dev/stderr"
  fail = 1
}
END {
  exit fail
}
' "$recheck_rows" "$offender_rows"
