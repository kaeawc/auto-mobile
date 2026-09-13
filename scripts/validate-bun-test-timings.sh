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
#
# The recheck is bounded by capping how MANY files are re-run, worst first, not
# by abandoning the recheck when many files are over. Co-tenant load lands on
# dozens of unrelated suites at once, so "many offenders" is the noise signature
# rather than a regression signal; a real regression still shows up among the
# worst offenders and is failed on its isolated median. Files past the cap are
# reported as unverified: this gate never fails a re-runnable test it has no
# isolated evidence against.
#
# The cap is NOT allowed to hide the one thing this gate exists to catch. An
# offender that lives in a test file THIS change touched can be the change's own
# regression, and how many of those there are is bounded by the diff, not by the
# runner's load. So offenders split into two populations:
#
#   * CHANGED test files  - rechecked first and OUTSIDE the cap, and failed
#                           closed on their isolated median. Never deferred.
#   * UNCHANGED test files - compete for the cap, worst first. Past it they are
#                           reported as unverified and do not fail the gate:
#                           they cannot be this change's regression.
#
# Without a base ref there is no diff, so every offender is in the second
# population and the cap alone bounds the wall time.
set -euo pipefail

report_path="${1:-scratch/bun-test-report.xml}"
report_dir="${report_path%.xml}.d"
recheck_dir="${report_path%.xml}.recheck.d"
max_ms="${BUN_TEST_MAX_MS:-100}"
recheck_runs="${BUN_TEST_TIMING_RECHECK_RUNS:-3}"
# Wall-time ceiling on the recheck: at most this many distinct files in UNCHANGED
# test files are re-run, worst offender first. Offenders past it are reported,
# never failed. Offenders in changed test files ignore this cap entirely.
recheck_max_files="${BUN_TEST_TIMING_RECHECK_MAX_FILES:-8}"

# Every one of these is used in Bash arithmetic, where a leading zero means
# octal: `08` is an arithmetic error and `010` silently means eight. Digit-only
# validation let both through, so require a canonical positive decimal instead.
require_positive_int() {
  local name="$1" value="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "${name} must be a positive integer without leading zeros (got '${value}')." >&2
    exit 2
  fi
}

require_positive_int BUN_TEST_MAX_MS "$max_ms"
require_positive_int BUN_TEST_TIMING_RECHECK_RUNS "$recheck_runs"
require_positive_int BUN_TEST_TIMING_RECHECK_MAX_FILES "$recheck_max_files"

mkdir -p "$(dirname "$report_path")"

# Rows are separated by US (0x1f) rather than tab: a parameterized test title can
# contain a literal tab, and a tab-delimited row would shift the duration out of
# its field and read as zero, silently clearing an over-budget test.
field_sep=$'\037'

# One row per measured testcase: file, classname, name, milliseconds, the
# occurrence ordinal of that name within the report, and the report it came from.
# The ordinal keeps same-named tests in one file apart; the report id makes a
# recheck sample count independent runs rather than rows.
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
function sanitize(value) {
  # Only the delimiter itself and record-splitting control characters are
  # rewritten; a tab in a test title survives into its own field intact.
  gsub(/\037/, " ", value)
  gsub(/\r/, " ", value)
  return value
}
FNR == 1 {
  current_file = ""
  split("", occurrences)
}
/<testsuite/ {
  candidate = sanitize(decode_xml(attr($0, "file")))
  if (candidate != "") {
    current_file = candidate
  }
}
/<testcase/ {
  name = sanitize(decode_xml(attr($0, "name")))
  time_str = attr($0, "time")
  if (name == "" || time_str == "") {
    next
  }
  classname = sanitize(decode_xml(attr($0, "classname")))
  # Bun writes the source path on the <testcase> itself; only some releases also
  # repeat it on the enclosing <testsuite>. Read the testcase attribute first and
  # fall back to the one on the enclosing suite, so every real report stays
  # re-runnable.
  case_file = sanitize(decode_xml(attr($0, "file")))
  test_file = (case_file != "") ? case_file : current_file
  key = test_file SUBSEP classname SUBSEP name
  occurrences[key] += 1
  printf "%s%s%s%s%s%s%.6f%s%d%s%s\n", \
    test_file, sep, classname, sep, name, sep, time_str * 1000.0, \
    sep, occurrences[key], sep, FILENAME
}
'

testcase_rows() {
  awk -v sep="$field_sep" "$testcase_rows_awk" "$@"
}

# Test files this change touches. An offender in one of these is never deferred
# behind the recheck cap: it is the population this gate exists to catch, and
# the diff bounds how many of them there can be.
changed_test_files=()

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
      test/*.test.ts)
        if [[ "$file" != *.integration.test.ts && "$file" != test/stress/* ]]; then
          changed_test_files+=("$file")
        fi
        ;;
    esac
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
rechecked_list="$recheck_dir/rechecked-files.txt"
deferred_list="$recheck_dir/deferred-files.txt"
changed_test_list="$recheck_dir/changed-test-files.txt"

: > "$changed_test_list"
for file in ${changed_test_files[@]+"${changed_test_files[@]}"}; do
  printf '%s\n' "$file" >> "$changed_test_list"
done

# Report paths and `git diff` paths are both repository-relative here; tolerate a
# leading "./" on the report side rather than silently treating a changed file as
# unchanged (which would let the cap defer it).
is_changed_test_file() {
  local candidate="${1#./}"
  [[ -s "$changed_test_list" ]] || return 1
  grep -Fxq -- "$candidate" "$changed_test_list"
}

testcase_rows "$@" > "$measured_rows"
if [[ ! -s "$measured_rows" ]]; then
  echo "No testcases found in junit report." >&2
  exit 1
fi

awk -F"$field_sep" -v limit_ms="$max_ms" '
$4 + 0 > limit_ms && !seen[$1 FS $2 FS $3 FS $5]++
' "$measured_rows" | sort > "$offender_rows"

if [[ ! -s "$offender_rows" ]]; then
  exit 0
fi

# Distinct files owning a provisional offender, worst sample first. A report
# without a `file` attribute cannot be re-run, so there the first sample stands.
offender_files=()
while IFS= read -r file; do
  offender_files+=("$file")
done < <(
  awk -F"$field_sep" -v sep="$field_sep" '
    $1 == "" { next }
    !($1 in worst) || $4 + 0 > worst[$1] { worst[$1] = $4 + 0 }
    END {
      for (file in worst) {
        printf "%015.6f%s%s\n", worst[file], sep, file
      }
    }
  ' "$offender_rows" | sort -r | cut -d"$field_sep" -f2-
)

: > "$recheck_rows"
: > "$rechecked_list"
: > "$deferred_list"
recheck_files=()
changed_offender_count=0
capped_recheck_count=0
deferred_count=0

# Pass 1: offenders in test files this change touched. Always rechecked, first
# and outside the cap, and failed closed on their isolated median.
for file in ${offender_files[@]+"${offender_files[@]}"}; do
  if [[ ! -f "$file" ]]; then
    # Nothing to re-run; the first sample stands for this file's offenders.
    continue
  fi
  # Invoke separately (not in a condition) so set -e stays armed inside the call.
  set +e
  is_changed_test_file "$file"
  changed_test_status=$?
  set -e
  if [[ "$changed_test_status" -eq 0 ]]; then
    recheck_files+=("$file")
    printf '%s\n' "$file" >> "$rechecked_list"
    changed_offender_count=$((changed_offender_count + 1))
  fi
done

# Pass 2: offenders in test files this change did not touch. These compete for
# the cap, worst first; past it they are reported, never failed.
for file in ${offender_files[@]+"${offender_files[@]}"}; do
  if [[ ! -f "$file" ]]; then
    continue
  fi
  # Invoke separately (not in a condition) so set -e stays armed inside the call.
  set +e
  is_changed_test_file "$file"
  changed_test_status=$?
  set -e
  if [[ "$changed_test_status" -eq 0 ]]; then
    continue
  fi
  if [[ "$capped_recheck_count" -lt "$recheck_max_files" ]]; then
    recheck_files+=("$file")
    printf '%s\n' "$file" >> "$rechecked_list"
    capped_recheck_count=$((capped_recheck_count + 1))
  else
    deferred_count=$((deferred_count + 1))
    printf '%s\n' "$file" >> "$deferred_list"
  fi
done

if [[ "${#recheck_files[@]}" -gt 0 ]]; then
  echo "Rechecking ${#recheck_files[@]} file(s) over the ${max_ms}ms budget: ${recheck_runs} isolated run(s) each, median enforced."
fi
if [[ "$changed_offender_count" -gt 0 ]]; then
  echo "${changed_offender_count} of them are test file(s) this change touches: rechecked first, outside the ${recheck_max_files}-file cap, and failed on their isolated median."
fi
if [[ "$deferred_count" -gt 0 ]]; then
  echo "${deferred_count} file(s) over the ${max_ms}ms budget were not rechecked (recheck capped at ${recheck_max_files} file(s), worst first, among test files this change did NOT touch); reporting them as unverified rather than failing them without isolated evidence."
fi

if [[ "${#recheck_files[@]}" -gt 0 ]]; then
  recheck_index=0
  for file in "${recheck_files[@]}"; do
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

awk -F"$field_sep" \
  -v limit_ms="$max_ms" \
  -v recheck_file="$recheck_rows" \
  -v rechecked_file="$rechecked_list" \
  -v deferred_file="$deferred_list" \
  -v recheck_runs="$recheck_runs" '
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
FILENAME == rechecked_file { rechecked[$0] = 1; next }
FILENAME == deferred_file { deferred[$0] = 1; next }
FILENAME == recheck_file {
  key = $1 SUBSEP $2 SUBSEP $3 SUBSEP $5
  # One sample per recheck PROCESS. Counting rows would let two same-named
  # tests in one file look like two independent runs of one test.
  if (!(key SUBSEP $6 in seen_run)) {
    seen_run[key SUBSEP $6] = 1
    samples[key] = (key in samples) ? samples[key] "," $4 : $4
    runs[key] += 1
  }
  next
}
{
  key = $1 SUBSEP $2 SUBSEP $3 SUBSEP $5
  label = ($2 != "" && $3 != "") ? $2 "." $3 : $3
  if ($5 + 0 > 1) {
    label = label " #" $5
  }
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
  if ($1 in rechecked) {
    printf "Test exceeded %dms: %s (%.2fms; recheck produced 0 of %d isolated samples)\n", limit_ms, label, $4, recheck_runs > "/dev/stderr"
    fail = 1
    next
  }
  if ($1 in deferred) {
    # Bounded recheck, worst first, over files this change did not touch: without
    # an isolated median this sample is not evidence of a regression by THIS
    # change, so report it instead of failing on it.
    printf "Budget not verified for %s (first sample %.2fms): the recheck was capped before reaching its file, which this change did not touch.\n", label, $4
    next
  }
  printf "Test exceeded %dms: %s (%.2fms)\n", limit_ms, label, $4 > "/dev/stderr"
  fail = 1
}
END {
  exit fail
}
' "$rechecked_list" "$deferred_list" "$recheck_rows" "$offender_rows"
