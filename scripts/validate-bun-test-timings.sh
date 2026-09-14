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
# Every re-runnable offender gets its isolated median: test files this change
# touched go first, then every remaining file by worst first sample. This avoids
# treating an unchanged file as safe when a source/runtime/shared-test change can
# slow every unit test. Rechecking is wall-time bounded instead: if the recheck
# budget expires before all queued files have complete medians, the gate fails
# closed and identifies the offenders that need a larger budget.
set -euo pipefail

report_path="${1:-scratch/bun-test-report.xml}"
report_dir="${report_path%.xml}.d"
recheck_dir="${report_path%.xml}.recheck.d"
max_ms="${BUN_TEST_MAX_MS:-100}"
recheck_runs="${BUN_TEST_TIMING_RECHECK_RUNS:-3}"
recheck_budget_seconds="${BUN_TEST_TIMING_RECHECK_BUDGET_SECONDS:-600}"

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
require_positive_int BUN_TEST_TIMING_RECHECK_BUDGET_SECONDS "$recheck_budget_seconds"

mkdir -p "$(dirname "$report_path")"

# Rows are separated by US (0x1f) rather than tab: a parameterized test title can
# contain a literal tab, and a tab-delimited row would shift the duration out of
# its field and read as zero, silently clearing an over-budget test.
field_sep=$'\037'

# One row per measured testcase: file, classname, name, milliseconds, the
# occurrence ordinal of that name within the report, and the report it came from.
# The seventh field uses Bun's testcase source line when available, keeping a
# duplicate stable across a full run and an isolated recheck even if the
# per-report ordinal shifts; older Bun reports fall back to that ordinal. The
# report id makes a recheck sample count independent runs rather than rows.
testcase_rows() {
  bun run scripts/lib/junit-testcase-timings.ts "$@"
}

# Test files this change touches recheck first. Runtime inputs and shared test
# support can affect every unit test, so all other offenders are also rechecked.
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
      src/*|package.json|bun.lock|bunfig.toml|scripts/test-ts.sh|scripts/validate-bun-test-timings.sh|scripts/lib/junit-testcase-timings.ts)
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
unverified_list="$recheck_dir/unverified-files.txt"
changed_test_list="$recheck_dir/changed-test-files.txt"

: > "$changed_test_list"
for file in ${changed_test_files[@]+"${changed_test_files[@]}"}; do
  printf '%s\n' "$file" >> "$changed_test_list"
done

# Report paths and `git diff` paths are both repository-relative here; tolerate a
# leading "./" on the report side rather than silently treating a changed file as
# unchanged (which would put it after the changed-file recheck pass).
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

# Exact-name testcases from one parameterized declaration can share
# (file, classname, name, line) -- see test/features/utility/DisplayConfig.test.ts:130-132.
# Keying by that identity alone and keeping the first matching row would let a
# fast sibling's row stand in for a slow one, so aggregate the MAXIMUM duration
# seen for each identity before deciding whether it is over budget.
awk -F"$field_sep" -v limit_ms="$max_ms" '
{
  key = $1 FS $2 FS $3 FS $7
  if (!(key in maxval) || $4 + 0 > maxval[key]) {
    maxval[key] = $4 + 0
    maxrow[key] = $0
  }
}
END {
  for (key in maxrow) {
    if (maxval[key] > limit_ms) {
      print maxrow[key]
    }
  }
}
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
: > "$unverified_list"
recheck_files=()
changed_offender_count=0

# Pass 1: offenders in test files this change touched. Recheck them first.
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

# Pass 2: every remaining re-runnable offender, worst first.
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
  recheck_files+=("$file")
  printf '%s\n' "$file" >> "$rechecked_list"
done

if [[ "${#recheck_files[@]}" -gt 0 ]]; then
  echo "Rechecking ${#recheck_files[@]} file(s) over the ${max_ms}ms budget: ${recheck_runs} isolated run(s) each, median enforced."
fi
if [[ "$changed_offender_count" -gt 0 ]]; then
  echo "${changed_offender_count} of them are test file(s) this change touches and are rechecked first."
fi

recheck_started_at="$(date +%s)"
elapsed_recheck_seconds() {
  if [[ -n "${BUN_TEST_TIMING_FAKE_ELAPSED_SECONDS:-}" ]]; then
    printf '%s\n' "$BUN_TEST_TIMING_FAKE_ELAPSED_SECONDS"
  else
    echo "$(( $(date +%s) - recheck_started_at ))"
  fi
}

if [[ "${#recheck_files[@]}" -gt 0 ]]; then
  recheck_index=0
  recheck_reports=()
  for file in "${recheck_files[@]}"; do
    elapsed_seconds="$(elapsed_recheck_seconds)"
    if [[ "$elapsed_seconds" -ge "$recheck_budget_seconds" ]]; then
      printf '%s\n' "$file" >> "$unverified_list"
      continue
    fi
    file_complete=true
    for ((run = 0; run < recheck_runs; run += 1)); do
      elapsed_seconds="$(elapsed_recheck_seconds)"
      if [[ "$elapsed_seconds" -ge "$recheck_budget_seconds" ]]; then
        file_complete=false
        break
      fi
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
        recheck_reports+=("$recheck_report")
      fi
    done
    if [[ "$file_complete" != "true" ]]; then
      printf '%s\n' "$file" >> "$unverified_list"
    fi
  done
  if [[ "${#recheck_reports[@]}" -gt 0 ]]; then
    testcase_rows "${recheck_reports[@]}" > "$recheck_rows"
  fi
fi

awk -F"$field_sep" \
  -v limit_ms="$max_ms" \
  -v limit_budget="$recheck_budget_seconds" \
  -v recheck_file="$recheck_rows" \
  -v rechecked_file="$rechecked_list" \
  -v unverified_file="$unverified_list" \
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
FILENAME == unverified_file { unverified[$0] = 1; next }
FILENAME == recheck_file {
  key = $1 SUBSEP $2 SUBSEP $3 SUBSEP $7
  runkey = key SUBSEP $6
  # One sample per recheck PROCESS (SUBSEP $6 pins the report). Exact-name
  # testcases from one parameterized declaration can share
  # (file, classname, name, line), so two rows can land on the same runkey; take
  # the MAXIMUM duration for that identity within this process rather than the
  # first row encountered, or a fast sibling could clear the median of a slow one.
  if (!(runkey in seen_run) || $4 + 0 > seen_run[runkey]) {
    if (!(runkey in seen_run)) {
      runs[key] += 1
    }
    seen_run[runkey] = $4 + 0
  }
  runkey_identity[runkey] = key
  next
}
{
  if (!recheck_finalized) {
    for (aggregated_runkey in seen_run) {
      aggregated_key = runkey_identity[aggregated_runkey]
      samples[aggregated_key] = (aggregated_key in samples) \
        ? samples[aggregated_key] "," seen_run[aggregated_runkey] \
        : seen_run[aggregated_runkey]
    }
    recheck_finalized = 1
  }
  key = $1 SUBSEP $2 SUBSEP $3 SUBSEP $7
  label = ($2 != "" && $3 != "") ? $2 "." $3 : $3
  if ($5 + 0 > 1) {
    label = label " #" $5
  }
  if ($1 in unverified) {
    printf "Could not verify within the %ds recheck budget: %s (first sample %.2fms). Raise BUN_TEST_TIMING_RECHECK_BUDGET_SECONDS to obtain an isolated median.\n", limit_budget, label, $4 > "/dev/stderr"
    fail = 1
    next
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
  printf "Test exceeded %dms: %s (%.2fms)\n", limit_ms, label, $4 > "/dev/stderr"
  fail = 1
}
END {
  exit fail
}
' "$rechecked_list" "$unverified_list" "$recheck_rows" "$offender_rows"
