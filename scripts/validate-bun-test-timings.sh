#!/usr/bin/env bash
#
# Enforce the repository's per-test unit budget ("unit tests pass in 100ms or
# less") against the JUnit reporter's per-test time, which already excludes
# beforeAll/beforeEach fixture work.
#
# Modes (in precedence order):
# - BUN_TEST_TIMING_BASE_REF: measure changed tests or reuse lane reports, as in CI.
# - --run-unit-lane (anywhere) or BUN_TEST_TIMING_RUN_LANE=1: run the full unit
#   lane; the optional positional argument is its output path.
# - An existing .xml file or directory containing *.xml: measure those reports
#   directly, running only isolated rechecks of provisional offenders.
# Without a base ref, running a lane always requires explicit opt-in.
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
# slow every unit test. Rechecking is wall-time bounded.
# Odd run counts can stop once every offender in a file has a complete-sample
# majority under budget: the configured median is then guaranteed to pass.
# If the wall-time budget expires before verification, fail closed. Widespread
# first-sample offenders suggest a runner stall, never permission to waive tests.
set -euo pipefail

# Bash 3.2 retains a failed echo in its stdio buffer when stdout is closed;
# a later command substitution can flush that text into an arithmetic value.
# Reopen only a closed descriptor before any progress output or subprocesses.
if ! { : 3>&1; } 2>/dev/null; then
  exec > /dev/null
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=scripts/lib/bun-unit-test.sh
source "$ROOT/scripts/lib/bun-unit-test.sh"
runner_os="${RUNNER_OS:-}"
if [[ -z "$runner_os" && "$(uname -s)" == Darwin ]]; then
  runner_os=macOS
fi
configure_bun_unit_test "$ROOT" "$runner_os"
# shellcheck source=scripts/ios/run_with_timeout.sh
source "$ROOT/scripts/ios/run_with_timeout.sh"

usage() {
  cat >&2 <<'EOF'
Usage: scripts/validate-bun-test-timings.sh [--run-unit-lane] [report.xml|report-directory]

An existing .xml file or directory containing *.xml is measured directly.
To run the full unit lane, pass --run-unit-lane (anywhere) or set
BUN_TEST_TIMING_RUN_LANE=1; only then is the positional argument an output path
(default: scratch/bun-test-report.xml).
BUN_TEST_TIMING_BASE_REF takes precedence and preserves changed-test/CI mode.
EOF
}

report_path=""
run_unit_lane="${BUN_TEST_TIMING_RUN_LANE:-0}"
for arg in "$@"; do
  case "$arg" in
    --run-unit-lane) run_unit_lane=1 ;;
    -*) usage; exit 2 ;;
    *)
      if [[ -n "$report_path" || -z "$arg" ]]; then
        usage
        exit 2
      fi
      report_path="$arg"
      ;;
  esac
done

if [[ -z "${BUN_TEST_TIMING_BASE_REF:-}" && "$run_unit_lane" != 1 ]]; then
  has_report=false
  if [[ -f "$report_path" && "$report_path" == *.xml ]]; then
    has_report=true
  elif [[ -d "$report_path" ]]; then
    for source_report in "$report_path"/*.xml; do
      if [[ -f "$source_report" ]]; then
        has_report=true
        break
      fi
    done
  fi
  if [[ "$has_report" != true ]]; then
    echo "Expected an existing JUnit XML file or directory of XML reports; a full lane requires --run-unit-lane." >&2
    usage
    exit 2
  fi
fi

report_path="${report_path:-scratch/bun-test-report.xml}"
# Keep direct-directory recheck scratch outside its inputs, preserving legacy
# output paths in BASE_REF and explicit lane modes.
if [[ -z "${BUN_TEST_TIMING_BASE_REF:-}" && "$run_unit_lane" != 1 && -d "$report_path" ]]; then
  while [[ "$report_path" == */ && "$report_path" != / ]]; do report_path="${report_path%/}"; done
fi
report_dir="${report_path%.xml}.d"
recheck_dir="${report_path%.xml}.recheck.d"
max_ms="${BUN_TEST_MAX_MS:-100}"
recheck_runs="${BUN_TEST_TIMING_RECHECK_RUNS:-3}"
recheck_budget_seconds="${BUN_TEST_TIMING_RECHECK_BUDGET_SECONDS:-600}"
stall_min_offenders="${BUN_TEST_TIMING_STALL_MIN_OFFENDERS:-25}"
# Contention-aware recheck: each isolated run is bracketed by a calibration probe.
# A run whose probe slowdown exceeds the threshold is retried (at most
# BUN_TEST_TIMING_CONTENTION_RETRIES extra times; 0 disables retrying) and the
# least-contended attempt is kept. Samples are never scaled, so the isolated
# median still enforces the unscaled budget and a genuinely slow test still fails.
# BUN_TEST_TIMING_PROBE_COMMAND is a test seam: an executable printing a slowdown.
contention_slowdown="${BUN_TEST_TIMING_CONTENTION_SLOWDOWN:-1.5}"
contention_retries="${BUN_TEST_TIMING_CONTENTION_RETRIES:-2}"
# A shard with at least this many over-budget first samples is reported as contended.
contended_shard_min="${BUN_TEST_TIMING_CONTENDED_SHARD_MIN:-10}"

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
require_positive_int BUN_TEST_TIMING_STALL_MIN_OFFENDERS "$stall_min_offenders"
require_positive_int BUN_TEST_TIMING_CONTENDED_SHARD_MIN "$contended_shard_min"
if [[ ! "$contention_retries" =~ ^(0|[1-9][0-9]*)$ ]]; then
  echo "BUN_TEST_TIMING_CONTENTION_RETRIES must be a non-negative integer without leading zeros (got '${contention_retries}')." >&2
  exit 2
fi
if [[ ! "$contention_slowdown" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  echo "BUN_TEST_TIMING_CONTENTION_SLOWDOWN must be a non-negative decimal (got '${contention_slowdown}')." >&2
  exit 2
fi

mkdir -p "$(dirname "$report_path")"

# The staging/recheck directories are derived from the caller-supplied report
# path (`<report>.d`, `<report>.recheck.d`), so an unrelated sibling directory
# can sit at the same name. Only a directory this script created earlier (it
# carries the marker) may be deleted; anything else non-empty is refused rather
# than removed (#14500).
scratch_marker=".bun-test-timings-scratch"
reset_scratch_dir() {
  local dir="$1"
  case "$dir" in
    "" | / | . | .. | "$HOME" | "$HOME/")
      echo "Refusing to use '${dir}' as timing scratch." >&2
      exit 2
      ;;
  esac
  if [[ -L "$dir" ]]; then
    echo "Refusing to reuse symlinked timing scratch '${dir}'; remove it and retry." >&2
    exit 2
  fi
  if [[ -d "$dir" && ! -e "$dir/$scratch_marker" ]]; then
    if [[ -n "$(ls -A "$dir" 2> /dev/null)" ]]; then
      echo "Refusing to delete '${dir}': it was not created by this script (no ${scratch_marker}). Remove it or pick another report path." >&2
      exit 2
    fi
  elif [[ -d "$dir" ]]; then
    rm -rf "$dir"
  elif [[ -e "$dir" ]]; then
    echo "Refusing to replace non-directory '${dir}' with timing scratch." >&2
    exit 2
  fi
  mkdir -p "$dir"
  : > "$dir/$scratch_marker"
}

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
  reset_scratch_dir "$report_dir"
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
      src/*|package.json|bun.lock|bunfig.toml|scripts/test-ts.sh|scripts/validate-bun-test-timings.sh|scripts/lib/junit-testcase-timings.ts|scripts/lib/bun-unit-test.sh|scripts/lib/bun-unit-groups.sh|scripts/lib/bun-unit-chunks.sh|scripts/test/classify-shared-safe.ts|test/shared-process-allowlist.txt)
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

  # Instrumented reports screen the complete merged suite, even for a docs-only
  # merge. Their durations never decide failure: offenders run below using the
  # uninstrumented canonical unit command and its isolated median.
  if [[ "$affects_unit_tests" == true || "${BUN_TEST_TIMING_REPORTS_INSTRUMENTED:-false}" == true ]]; then
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
      echo "Source changes detected; measuring complete unit-lane reports." || true
      report_dir="$source_report_dir"
    else
      echo "Source changes detected; measuring Bun-affected unit tests." || true
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
          "${BUN_UNIT_TEST_COMMAND[@]}" \
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
    echo "No changed unit tests to validate against the ${max_ms}ms budget." || true
    exit 0
  fi
elif [[ "$run_unit_lane" == 1 ]]; then
  AUTOMOBILE_UNIT_JUNIT_DIR="$report_dir" bash scripts/test-ts.sh unit
elif [[ -d "$report_path" ]]; then
  report_dir="$report_path"
else
  # Stage a single report for the same glob/calibration/recheck path as shards.
  reset_scratch_dir "$report_dir"
  # A fixed, visible name also includes dot-prefixed inputs in the shard glob.
  cp "$report_path" "$report_dir/report.xml"
fi

# A unit lane may recreate its junit directory and drop the marker. The derived
# directory is scratch this run populated, so re-mark it for the next run.
if [[ "$report_dir" == "${report_path%.xml}.d" && -d "$report_dir" && ! -L "$report_dir" ]]; then
  : > "$report_dir/$scratch_marker"
fi

set -- "$report_dir"/*.xml
if [[ ! -f "$1" ]]; then
  if [[ -n "${BUN_TEST_TIMING_BASE_REF:-}" && "$affects_unit_tests" == "true" && -z "${BUN_TEST_TIMING_REPORT_DIR:-}" ]]; then
    # Bun exits successfully for empty --changed shards without writing JUnit.
    echo "No changed unit tests to validate against the ${max_ms}ms budget." || true
    exit 0
  fi
  echo "No JUnit shard reports found in ${report_dir}." >&2
  exit 1
fi

# Runner calibration (#10583). Each unit shard records a fixed probe's duration
# at its start and end (scripts/lib/runner-calibration.ts, written next to the
# JUnit reports). A starved runner inflates every FIRST sample by about that
# slowdown, so the first-sample budget scales by the worst shard slowdown,
# capped at BUN_TEST_TIMING_MAX_SLOWDOWN. The isolated median recheck is
# unchanged and still enforces the unscaled budget. Above
# BUN_TEST_TIMING_INFRA_SLOWDOWN the runner is classified as starved: offenders
# that could only be judged on that starved first sample (not re-runnable, or
# not verified within the recheck budget) become infra warnings instead of
# failures. BUN_TEST_TIMING_SLOWDOWN overrides the measured value (1 disables
# scaling); without calibration samples the budget is unscaled.
max_slowdown="${BUN_TEST_TIMING_MAX_SLOWDOWN:-4}"
infra_slowdown="${BUN_TEST_TIMING_INFRA_SLOWDOWN:-4}"
require_positive_int BUN_TEST_TIMING_MAX_SLOWDOWN "$max_slowdown"
require_positive_int BUN_TEST_TIMING_INFRA_SLOWDOWN "$infra_slowdown"
if [[ "${BUN_TEST_TIMING_REPORTS_INSTRUMENTED:-false}" == true ]]; then
  # Instrumentation is not runner contention. Screen at the unscaled 100ms
  # threshold and fail closed if a plain recheck cannot verify every offender.
  export BUN_TEST_TIMING_SLOWDOWN=1
fi
runner_slowdown="${BUN_TEST_TIMING_SLOWDOWN:-}"
if [[ -z "$runner_slowdown" ]]; then
  if ! runner_slowdown="$(bun "$ROOT/scripts/lib/runner-calibration.ts" slowdown "$report_dir")"; then
    # Calibration only relaxes the gate; without it the unscaled budget applies.
    echo "Could not read runner calibration samples in ${report_dir}; using the unscaled ${max_ms}ms budget." >&2
    runner_slowdown=""
  fi
fi
if [[ -n "$runner_slowdown" && ! "$runner_slowdown" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  echo "BUN_TEST_TIMING_SLOWDOWN must be a non-negative decimal (got '${runner_slowdown}')." >&2
  exit 2
fi
first_sample_limit_ms="$max_ms"
runner_starved=0
calibration_note=""
if [[ -n "$runner_slowdown" ]]; then
  read -r first_sample_limit_ms runner_starved slowdown_multiplier < <(
    awk -v slowdown="$runner_slowdown" -v cap="$max_slowdown" -v infra="$infra_slowdown" -v budget="$max_ms" '
      BEGIN {
        multiplier = slowdown + 0 < 1 ? 1 : slowdown + 0
        if (multiplier > cap + 0) multiplier = cap + 0
        printf "%.2f %d %.2f\n", budget * multiplier, (slowdown + 0 > infra + 0), multiplier
      }'
  )
  calibration_note="Runner calibration: slowdown ${runner_slowdown}x; first-sample budget ${first_sample_limit_ms}ms (x${slowdown_multiplier}, cap ${max_slowdown}x); isolated rechecks still enforce ${max_ms}ms."
  if [[ "$runner_starved" -eq 1 ]]; then
    calibration_note+=" Runner starved (slowdown above ${infra_slowdown}x): offenders without an isolated median are infra warnings, not failures."
  fi
  echo "$calibration_note" || true
fi

reset_scratch_dir "$recheck_dir"
# Per-shard slowdowns (final attempt only) scope the budget to the shard that
# produced each sample. An explicit BUN_TEST_TIMING_SLOWDOWN applies to all.
shard_slowdowns_file="$recheck_dir/shard-slowdowns.tsv"
: > "$shard_slowdowns_file"
if [[ -z "${BUN_TEST_TIMING_SLOWDOWN:-}" ]]; then
  if ! bun "$ROOT/scripts/lib/runner-calibration.ts" shard-slowdowns "$report_dir" > "$shard_slowdowns_file"; then
    : > "$shard_slowdowns_file"
  fi
fi
measured_rows="$recheck_dir/measured.tsv"
offender_rows="$recheck_dir/offenders.tsv"
recheck_rows="$recheck_dir/recheck.tsv"
identity_counts="$recheck_dir/identity-counts.tsv"
rechecked_list="$recheck_dir/rechecked-files.txt"
unverified_list="$recheck_dir/unverified-files.txt"
early_stopped_list="$recheck_dir/early-stopped-files.txt"
changed_test_list="$recheck_dir/changed-test-files.txt"
recheck_summary="$recheck_dir/summary.txt"
recheck_verdict_file="$recheck_dir/verdict.txt"
budget_summary="$recheck_dir/unit-timing-budget-summary.md"
failure_list="$recheck_dir/failures.txt"
failure_counts="$recheck_dir/failure-counts.txt"
warning_list="$recheck_dir/infra-warnings.txt"

: > "$changed_test_list"
: > "$warning_list"
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

# Count same-identity rows in each initial report, retaining the largest count
# when the identity appears in multiple initial reports. A recheck process that
# omits a same-line sibling is not a complete sample for that identity.
awk -F"$field_sep" '
{
  key = $1 FS $2 FS $3 FS $7
  report_key = key SUBSEP $6
  report_rows[report_key] += 1
  report_identity[report_key] = key
}
END {
  for (report_key in report_rows) {
    key = report_identity[report_key]
    if (!(key in identity_count) || report_rows[report_key] > identity_count[key]) {
      identity_count[key] = report_rows[report_key]
    }
  }
  for (key in identity_count) {
    print key FS identity_count[key]
  }
}
' "$measured_rows" > "$identity_counts"

# Exact-name testcases from one parameterized declaration can share
# (file, classname, name, line) -- see test/features/utility/DisplayConfig.test.ts:130-132.
# Keying by that identity alone and keeping the first matching row would let a
# fast sibling's row stand in for a slow one, so aggregate the MAXIMUM duration
# seen for each identity before deciding whether it is over budget. The first
# sample is compared with the calibration-scaled budget (unscaled by default).
awk -F"$field_sep" -v budget="$max_ms" -v cap="$max_slowdown" \
  -v override="${BUN_TEST_TIMING_SLOWDOWN:-}" -v slowdown_file="$shard_slowdowns_file" '
function shard_key(report,   base) {
  base = report
  sub(/^.*\//, "", base)
  if (match(base, /^(changed-)?shard-[0-9]+/)) return substr(base, 1, RLENGTH)
  return base
}
function limit_for(report,   s, k) {
  k = shard_key(report)
  s = (override != "") ? override + 0 : ((k in shard_slowdown) ? shard_slowdown[k] : 1)
  if (s < 1) s = 1
  if (s > cap + 0) s = cap + 0
  return budget * s
}
BEGIN {
  while ((getline line < slowdown_file) > 0) {
    split(line, parts, "\t")
    shard_slowdown[parts[1]] = parts[2] + 0
  }
  close(slowdown_file)
}
{
  key = $1 FS $2 FS $3 FS $7
  if ($4 + 0 > limit_for($6) && (!(key in maxval) || $4 + 0 > maxval[key])) {
    maxval[key] = $4 + 0
    maxrow[key] = $0
  }
}
END {
  for (key in maxrow) print maxrow[key]
}
' "$measured_rows" | sort > "$offender_rows"

if [[ ! -s "$offender_rows" ]]; then
  exit 0
fi

# This is a heuristic over the initial measurement window, not proof of load.
# Report the file spread and duration range without claiming causal certainty.
stall_notice="$(awk -F"$field_sep" -v threshold="$stall_min_offenders" '
  { files[$1] = 1; count++; if (count == 1 || $4 < low) low = $4; if ($4 > high) high = $4 }
  END {
    for (file in files) file_count++
    if (count >= threshold) printf "Runner stall suspected: %d distinct over-budget tests across %d file(s) in the first-sample window (%.2fms to %.2fms).", count, file_count, low, high
  }
' "$offender_rows")"
if [[ -n "$stall_notice" ]]; then
  echo "$stall_notice" || true
fi

# The start/end calibration probes bracket a shard but cannot see contention in
# its middle (they report 1.00x while dozens of tests breach). A shard with many
# unscaled over-budget first samples is therefore recorded as contended, so a
# reader of a red run can tell "runner contended" from "test slow".
contention_notice="$(awk -F"$field_sep" -v budget="$max_ms" -v threshold="$contended_shard_min" '
  {
    base = $6
    sub(/^.*\//, "", base)
    if (match(base, /^(changed-)?shard-[0-9]+/)) base = substr(base, 1, RLENGTH)
    if ($4 + 0 > budget + 0) over[base]++
  }
  END {
    for (shard in over) if (over[shard] >= threshold) {
      printf "%s%s: %d over-budget first samples", (text == "" ? "" : "; "), shard, over[shard]
      text = "x"
    }
    if (text != "") printf "."
  }
' "$measured_rows")"
if [[ -n "$contention_notice" ]]; then
  contention_notice="Runner contended (>= ${contended_shard_min} over-budget first samples in one shard; start/end probes cannot see mid-run contention) - ${contention_notice} First-sample overruns there say nothing about those tests; only the probe-bracketed isolated median below does."
  echo "$contention_notice" || true
fi

# Count only complete identity samples, using each process maximum for same-line
# siblings just as the final verdict does. Every offender must have a majority.
file_majority_under_budget() {
  awk -F"$field_sep" -v candidate="$1" -v limit_ms="$max_ms" \
    -v majority="$((recheck_runs / 2 + 1))" \
    -v counts_file="$identity_counts" -v rows_file="$file_recheck_rows" '
    FILENAME == counts_file { expected[$1 SUBSEP $2 SUBSEP $3 SUBSEP $4] = $5; next }
    FILENAME == rows_file {
      key = $1 SUBSEP $2 SUBSEP $3 SUBSEP $7
      runkey = key SUBSEP $6
      identities[runkey] = key
      rows[runkey]++
      if (!(runkey in worst) || $4 + 0 > worst[runkey]) worst[runkey] = $4 + 0
      next
    }
    $1 == candidate { offenders[$1 SUBSEP $2 SUBSEP $3 SUBSEP $7] = 1 }
    END {
      for (runkey in rows) {
        key = identities[runkey]
        if (rows[runkey] >= expected[key] && worst[runkey] <= limit_ms) under[key]++
      }
      for (key in offenders) if (under[key] < majority) exit 1
    }
  ' "$identity_counts" "$file_recheck_rows" "$offender_rows"
}

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
: > "$early_stopped_list"
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
  echo "Rechecking ${#recheck_files[@]} file(s) over the ${max_ms}ms budget: ${recheck_runs} isolated run(s) each, median enforced." || true
fi
if [[ "$changed_offender_count" -gt 0 ]]; then
  echo "${changed_offender_count} of them are test file(s) this change touches and are rechecked first." || true
fi

recheck_started_at="$(date +%s)"
elapsed_recheck_seconds() {
  if [[ -n "${BUN_TEST_TIMING_FAKE_ELAPSED_SECONDS:-}" ]]; then
    printf '%s\n' "$BUN_TEST_TIMING_FAKE_ELAPSED_SECONDS"
  else
    echo "$(( $(date +%s) - recheck_started_at ))"
  fi
}

probe_rows="$recheck_dir/recheck-probes.tsv"
probe_by_file="$recheck_dir/recheck-probes-by-file.tsv"
: > "$probe_rows"
: > "$probe_by_file"

# Prints 1 when decimal $1 is greater than decimal $2, else 0. Called in a command
# substitution so set -e stays armed (it is not an if/! condition).
decimal_gt() {
  awk -v a="$1" -v b="$2" 'BEGIN { print (a + 0 > b + 0) ? 1 : 0 }'
}

decimal_max() {
  awk -v a="$1" -v b="$2" 'BEGIN { printf "%.2f\n", (a + 0 > b + 0 ? a : b) + 0 }'
}

# One calibration probe: prints the runner slowdown (>= 1). A probe that fails or
# prints garbage reads as 1.00, so a broken probe can only skip retries, never
# loosen the verdict (samples are not scaled).
recheck_probe_slowdown() {
  local value=""
  if [[ -n "${BUN_TEST_TIMING_PROBE_COMMAND:-}" ]]; then
    value="$("$BUN_TEST_TIMING_PROBE_COMMAND" 2> /dev/null)" || value=""
  else
    local probe_status caller_options="$-"
    set +e
    value="$(run_with_timeout 15 bun "$ROOT/scripts/lib/runner-calibration.ts" measure 2> /dev/null)"
    probe_status=$?
    if [[ "$caller_options" == *e* ]]; then set -e; fi
    if [[ "$probe_status" -ne 0 ]]; then value=""; fi
  fi
  if [[ ! "$value" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    echo "Recheck runner probe returned no usable slowdown; treating it as 1.00x." >&2 || true
    value=1.00
  fi
  decimal_max "$value" 1
}

if [[ "${#recheck_files[@]}" -gt 0 ]]; then
  recheck_index=0
  recheck_file_pos=0
  attempt_seconds_total=0
  attempt_count=0
  for file in "${recheck_files[@]}"; do
    recheck_file_pos=$((recheck_file_pos + 1))
    elapsed_seconds="$(elapsed_recheck_seconds)"
    if [[ "$elapsed_seconds" -ge "$recheck_budget_seconds" ]]; then
      printf '%s\n' "$file" >> "$unverified_list"
      continue
    fi
    file_complete=true
    file_recheck_rows="$recheck_dir/file-recheck.tsv"
    : > "$file_recheck_rows"
    for ((run = 0; run < recheck_runs; run += 1)); do
      elapsed_seconds="$(elapsed_recheck_seconds)"
      if [[ "$elapsed_seconds" -ge "$recheck_budget_seconds" ]]; then
        file_complete=false
        break
      fi
      # Each attempt is bracketed by a calibration probe. A contended attempt is
      # retried (bounded) and the least-contended attempt's sample is the run's
      # sample; the sample itself is never scaled.
      attempt=0
      have_best=false
      run_aborted=false
      best_tsv="$recheck_dir/run-best.tsv"
      best_contention=""
      while :; do
        elapsed_seconds="$(elapsed_recheck_seconds)"
        recheck_report="$recheck_dir/recheck-${recheck_index}.xml"
        recheck_index=$((recheck_index + 1))
        probe_before="$(recheck_probe_slowdown)"
        # The whole file, so module load and JIT warm-up are amortized the way
        # the real unit lane amortizes them instead of being billed to one test.
        # A failing assertion here is the unit lane's business, not the budget's:
        # report it and keep measuring rather than exiting with a bare status.
        # Per-test timeouts do not bound a whole file (hooks/many tests can
        # exceed them). Bound this process by the remaining recheck allowance so
        # the validator, rather than the CI job timeout, prints the verdict.
        # Invoke separately so the function is not in an errexit-suppressed condition.
        set +e
        run_with_timeout "$((recheck_budget_seconds - elapsed_seconds))" \
          "${BUN_UNIT_TEST_COMMAND[@]}" \
          --reporter junit \
          --reporter-outfile "$recheck_report" \
          "$file"
        recheck_status=$?
        set -e
        probe_after="$(recheck_probe_slowdown)"
        attempt_ended_seconds="$(elapsed_recheck_seconds)"
        attempt_seconds_total=$((attempt_seconds_total + attempt_ended_seconds - elapsed_seconds))
        attempt_count=$((attempt_count + 1))
        if [[ "$recheck_status" -eq 124 || "$recheck_status" -eq 137 ]]; then
          # GNU timeout returns 137 if its two-second KILL escalation is needed.
          run_aborted=true
          break
        elif [[ "$recheck_status" -ne 0 ]]; then
          echo "Recheck run ${run} of ${file} did not pass; measuring whatever it reported." >&2
        fi
        if [[ ! -f "$recheck_report" ]]; then
          break
        fi
        testcase_rows "$recheck_report" > "$recheck_dir/run-recheck.tsv"
        attempt_contention="$(decimal_max "$probe_before" "$probe_after")"
        less_contended="$(decimal_gt "${best_contention:-0}" "$attempt_contention")"
        attempt_is_contended="$(decimal_gt "$attempt_contention" "$contention_slowdown")"
        if [[ "$have_best" != "true" || "$less_contended" == 1 ]]; then
          cp "$recheck_dir/run-recheck.tsv" "$best_tsv"
          best_contention="$attempt_contention"
          have_best=true
        fi
        if [[ "$attempt_is_contended" != 1 ]]; then
          break
        fi
        # An under-budget sample is conclusive however contended the runner was
        # (contention only inflates timings), so only an over-budget one is retried.
        if ! awk -F"$field_sep" -v limit="$max_ms" '$4 + 0 > limit + 0 { found = 1 } END { exit !found }' \
          "$recheck_dir/run-recheck.tsv"; then
          break
        fi
        printf 'Recheck run %d/%d of %s: runner contended (probe %sx before, %sx after; limit %sx); attempt %d of %d.\n' \
          "$((run + 1))" "$recheck_runs" "$file" "$probe_before" "$probe_after" "$contention_slowdown" \
          "$((attempt + 1))" "$((contention_retries + 1))" >&2 || true
        if [[ "$attempt" -ge "$contention_retries" ]]; then
          break
        fi
        # Retries must not starve verification: spend one only while the remaining
        # budget still covers a single attempt (mean attempt time so far, at least
        # 1s) for every run still to be verified, plus the retry itself.
        mean_attempt_seconds=$(((attempt_seconds_total + attempt_count - 1) / attempt_count))
        if [[ "$mean_attempt_seconds" -lt 1 ]]; then
          mean_attempt_seconds=1
        fi
        remaining_single_attempts=$(((recheck_runs - run - 1) + (${#recheck_files[@]} - recheck_file_pos) * recheck_runs))
        if [[ "$((recheck_budget_seconds - attempt_ended_seconds - mean_attempt_seconds * remaining_single_attempts))" -lt "$mean_attempt_seconds" ]]; then
          printf 'Recheck run %d/%d of %s: no contention retry; the remaining recheck budget is reserved for verifying the other runs.\n' \
            "$((run + 1))" "$recheck_runs" "$file" >&2 || true
          break
        fi
        attempt=$((attempt + 1))
      done
      if [[ "$run_aborted" == "true" ]]; then
        file_complete=false
        break
      fi
      if [[ "$have_best" == "true" ]]; then
        run_contended=0
        best_is_contended="$(decimal_gt "$best_contention" "$contention_slowdown")"
        if [[ "$best_is_contended" == 1 ]]; then
          run_contended=1
        fi
        printf '%s\t%s\t%s\t%s\t%s\n' "$file" "$((run + 1))" "$((attempt + 1))" "$best_contention" "$run_contended" >> "$probe_rows"
        # Log each isolated sample as it lands: the final verdict prints only
        # after every file is rechecked, and a job whose log is lost (#9751)
        # would otherwise show no trace that the median check ran at all.
        awk -F"$field_sep" -v file="$file" -v run="$((run + 1))" -v runs="$recheck_runs" '
          NR == 1 || $4 + 0 > worst { worst = $4 + 0 }
          END { if (NR > 0) printf "Recheck run %d/%d of %s: slowest testcase %.2fms.\n", run, runs, file, worst }
        ' "$best_tsv" >&2 || true
        printf 'Recheck run %d/%d of %s: runner probe slowdown %sx after %d attempt(s) (%s).\n' \
          "$((run + 1))" "$recheck_runs" "$file" "$best_contention" "$((attempt + 1))" \
          "$([[ "$run_contended" -eq 1 ]] && echo contended || echo quiet)" >&2 || true
        cat "$best_tsv" >> "$recheck_rows"
        cat "$best_tsv" >> "$file_recheck_rows"
        if (( recheck_runs % 2 == 1 && run + 1 < recheck_runs )); then
          # Invoke separately to preserve processing errors under errexit.
          set +e
          file_majority_under_budget "$file"
          majority_status=$?
          set -e
          if [[ "$majority_status" -gt 1 ]]; then
            exit "$majority_status"
          elif [[ "$majority_status" -eq 0 ]]; then
            printf '%s\n' "$file" >> "$early_stopped_list"
            break
          fi
        fi
      fi
    done
    if [[ "$file_complete" != "true" ]]; then
      printf '%s\n' "$file" >> "$unverified_list"
    fi
  done
fi

# Worst accepted probe slowdown per rechecked file, for the verdict summary.
awk -F"\t" '
  { if (!($1 in worst) || $4 + 0 > worst[$1]) worst[$1] = $4 + 0; if ($5 == 1) contended[$1] = 1 }
  END { for (f in worst) printf "%s\037%.2f\037%s\n", f, worst[f], (f in contended ? "contended" : "quiet") }
' "$probe_rows" > "$probe_by_file"

# Keep awk off the potentially non-blocking CI stdout. Its status still exposes
# genuine processing errors; the data verdict is recorded separately from output.
awk -F"$field_sep" \
  -v limit_ms="$max_ms" \
  -v stall_notice="$stall_notice" \
  -v contention_notice="$contention_notice" \
  -v probe_file="$probe_by_file" \
  -v early_stopped_file="$early_stopped_list" \
  -v limit_budget="$recheck_budget_seconds" \
  -v verdict_file="$recheck_verdict_file" \
  -v failure_list="$failure_list" \
  -v failure_counts="$failure_counts" \
  -v summary_file="$budget_summary" \
  -v identity_counts_file="$identity_counts" \
  -v recheck_file="$recheck_rows" \
  -v rechecked_file="$rechecked_list" \
  -v unverified_file="$unverified_list" \
  -v recheck_runs="$recheck_runs" \
  -v runner_starved="$runner_starved" \
  -v infra="$infra_slowdown" \
  -v override="${BUN_TEST_TIMING_SLOWDOWN:-}" \
  -v slowdown_file="$shard_slowdowns_file" \
  -v calibration_note="$calibration_note" \
  -v warning_list="$warning_list" '
function shard_key(report,   base) {
  base = report
  sub(/^.*\//, "", base)
  if (match(base, /^(changed-)?shard-[0-9]+/)) return substr(base, 1, RLENGTH)
  return base
}
# A row is starved only when ITS shard measured above the infra threshold; an
# explicit override applies to every shard, matching the global classification.
function starved_for(report,   k) {
  if (override != "") return runner_starved + 0
  k = shard_key(report)
  return (k in shard_slowdown) && shard_slowdown[k] > infra + 0
}
BEGIN {
  while ((getline line < slowdown_file) > 0) {
    split(line, parts, "\t")
    shard_slowdown[parts[1]] = parts[2] + 0
  }
  close(slowdown_file)
  printf "# Unit timing budget summary\n\nBudget: %dms; configured re-runs: %d\n", limit_ms, recheck_runs > summary_file
  if (calibration_note != "") printf "\n%s\n", calibration_note > summary_file
  if (stall_notice != "") printf "\n%s\n", stall_notice > summary_file
  if (contention_notice != "") printf "\n%s\n", contention_notice > summary_file
}
function record(verdict, measured_median,    values, count, sample_index, label_text, safe_label, sample_text) {
  # HTML-escape the label so testcase text cannot become Markdown structure.
  label_text = label
  gsub(/&/, "\\&amp;", label_text)
  gsub(/</, "\\&lt;", label_text)
  gsub(/>/, "\\&gt;", label_text)
  printf "\n<pre>%s</pre>\n\n- First sample: %.2fms\n- Re-run samples: ", label_text, $4 > summary_file
  count = (key in samples) ? split(samples[key], values, ",") : 0
  sample_text = ""
  for (sample_index = 1; sample_index <= count; sample_index += 1) {
    printf "%s%.2fms", (sample_index > 1 ? " / " : ""), values[sample_index] > summary_file
    sample_text = sample_text (sample_index > 1 ? " / " : "") sprintf("%.2fms", values[sample_index])
  }
  if (!count) printf "none" > summary_file
  if ($1 in probe_text) printf "\n- Runner probe during re-runs: %s", probe_text[$1] > summary_file
  printf "\n- Completed samples: %d of %d%s\n- Median: %s\n- Verdict: %s\n", runs[key] + 0, recheck_runs, (early_clear ? " (early stop: majority under budget)" : ""), measured_median, verdict > summary_file
  if (verdict ~ /^FAIL/) {
    safe_label = label
    gsub(/%/, "%25", safe_label)
    gsub(sprintf("%c", 13), "%0D", safe_label)
    gsub(sprintf("%c", 10), "%0A", safe_label)
    printf "FAIL: %s | %s | first sample: %.2fms | re-run samples: %s | median: %s\n", \
      safe_label, verdict, $4, (count ? sample_text : "none"), measured_median >> failure_list
    failures++
  } else if (verdict ~ /^WARN/) {
    safe_label = label
    gsub(/%/, "%25", safe_label)
    gsub(sprintf("%c", 13), "%0D", safe_label)
    gsub(sprintf("%c", 10), "%0A", safe_label)
    printf "WARN: %s | %s | first sample: %.2fms\n", safe_label, verdict, $4 >> warning_list
  } else {
    cleared++
  }
}
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
FILENAME == probe_file { probe_text[$1] = $2 "x, " $3; next }
FILENAME == early_stopped_file { early_stopped[$0] = 1; next }
FILENAME == rechecked_file { rechecked[$0] = 1; next }
FILENAME == unverified_file { unverified[$0] = 1; next }
FILENAME == identity_counts_file {
  key = $1 SUBSEP $2 SUBSEP $3 SUBSEP $4
  identity_count[key] = $5 + 0
  next
}
FILENAME == recheck_file {
  key = $1 SUBSEP $2 SUBSEP $3 SUBSEP $7
  runkey = key SUBSEP $6
  # One sample per recheck PROCESS (SUBSEP $6 pins the report). Exact-name
  # testcases from one parameterized declaration can share
  # (file, classname, name, line), so two rows can land on the same runkey; take
  # the MAXIMUM duration for that identity within this process rather than the
  # first row encountered, or a fast sibling could clear the median of a slow one.
  if (!(runkey in seen_run) || $4 + 0 > seen_run[runkey]) {
    seen_run[runkey] = $4 + 0
  }
  if (!(runkey in runkey_identity)) {
    run_order[++run_count] = runkey
  }
  run_rows[runkey] += 1
  runkey_identity[runkey] = key
  next
}
{
  if (!recheck_finalized) {
    # Retain report encounter order for diagnostics; median still sorts a copy.
    for (run_index = 1; run_index <= run_count; run_index += 1) {
      aggregated_runkey = run_order[run_index]
      aggregated_key = runkey_identity[aggregated_runkey]
      expected_rows = (aggregated_key in identity_count) ? identity_count[aggregated_key] : 1
      if (run_rows[aggregated_runkey] >= expected_rows) {
        runs[aggregated_key] += 1
        if (seen_run[aggregated_runkey] <= limit_ms) under[aggregated_key]++
        # Test membership before assigning: mawk creates the left-hand element
        # before evaluating the right-hand side, so `a[k] = (k in a) ? ...` is
        # always true there and prepends an empty (0ms) sample to the median.
        sample_list = seen_run[aggregated_runkey]
        if (aggregated_key in samples) {
          sample_list = samples[aggregated_key] "," sample_list
        }
        samples[aggregated_key] = sample_list
      }
    }
    recheck_finalized = 1
  }
  key = $1 SUBSEP $2 SUBSEP $3 SUBSEP $7
  early_clear = ($1 in early_stopped) && recheck_runs % 2 == 1 && under[key] >= int(recheck_runs / 2) + 1
  label = ($2 != "" && $3 != "") ? $2 "." $3 : $3
  if ($5 + 0 > 1) {
    label = label " #" $5
  }
  if ((key in samples) || ($1 in unverified) || ($1 in rechecked)) rechecked_tests++
  if (($1 in unverified) && !(key in samples) && starved_for($6)) {
    # The only evidence is a first sample from a shard the calibration probe
    # measured as starved: report infra, not a test regression. A file with
    # any complete isolated sample stays fail-closed (handled below).
    record("WARN (infra: starved runner; could not verify within the recheck budget)", "not computed")
    printf "Infra warning (starved runner): could not verify %s within the %ds recheck budget (first sample %.2fms; file %s).\n", label, limit_budget, $4, $1 > "/dev/stderr"
    next
  }
  if ($1 in unverified) {
    record("FAIL (could not verify within the recheck budget)", "not computed")
    printf "Could not verify within the %ds recheck budget: %s (first sample %.2fms; file %s). %s\n", limit_budget, label, $4, $1, (stall_notice != "" ? "Runner stall suspected; re-run the job on a quieter runner." : "Raise BUN_TEST_TIMING_RECHECK_BUDGET_SECONDS to obtain an isolated median.") > "/dev/stderr"
    fail = 1
    next
  }
  if (key in samples) {
    # A recheck run can die before the reporter writes this testcase, and a
    # median over the survivors is not the evidence the gate asked for: one fast
    # sample would clear a real breach. Only a deliberate majority-under early
    # stop guarantees the configured median; other incomplete sets still fail.
    if (early_clear) {
      record("PASS (cleared)", sprintf("guaranteed <= %dms", limit_ms))
      printf "Recheck cleared %s: configured median guaranteed <= %dms after %d isolated runs (early stop: majority under budget; first sample %.2fms).\n", label, limit_ms, runs[key], $4
      next
    }
    if (runs[key] < recheck_runs + 0) {
      record("FAIL (fewer samples than configured)", "not computed")
      printf "Test exceeded %dms: %s (%.2fms; recheck produced %d of %d isolated samples)\n", limit_ms, label, $4, runs[key], recheck_runs > "/dev/stderr"
      fail = 1
      next
    }
    effective = median(key)
    if (effective > limit_ms) {
      record("FAIL (median over budget)", sprintf("%.2fms", effective))
      printf "Test exceeded %dms: %s (median %.2fms of %d isolated runs)\n", limit_ms, label, effective, runs[key] > "/dev/stderr"
      fail = 1
    } else {
      record("PASS (cleared)", sprintf("%.2fms", effective))
      printf "Recheck cleared %s: median %.2fms over %d isolated runs (first sample %.2fms).\n", label, effective, runs[key], $4
    }
    next
  }
  if ($1 in rechecked) {
    record("FAIL (no samples)", "not computed")
    printf "Test exceeded %dms: %s (%.2fms; recheck produced 0 of %d isolated samples)\n", limit_ms, label, $4, recheck_runs > "/dev/stderr"
    fail = 1
    next
  }
  if (starved_for($6)) {
    record("WARN (infra: starved runner; not re-runnable)", "not computed")
    printf "Infra warning (starved runner): %s exceeded %dms on its only sample (%.2fms) and cannot be re-run.\n", label, limit_ms, $4 > "/dev/stderr"
    next
  }
  record("FAIL (not re-runnable; first sample stands)", "not computed")
  printf "Test exceeded %dms: %s (%.2fms)\n", limit_ms, label, $4 > "/dev/stderr"
  fail = 1
}
END {
  printf "\nOverall verdict: %s\n", (fail ? "FAIL" : "PASS") > summary_file
  print (fail ? 1 : 0) > verdict_file
  if (fail) {
    printf "FAIL: %d test(s)\n", failures >> failure_list
    printf "Rechecked tests: %d\nCleared tests: %d\nFailing tests: %d\n", rechecked_tests, cleared, failures > failure_counts
  }
}
' "$probe_by_file" "$early_stopped_list" "$rechecked_list" "$unverified_list" "$identity_counts" "$recheck_rows" "$offender_rows" > "$recheck_summary"

IFS= read -r recheck_verdict < "$recheck_verdict_file"
# cat handles partial writes/EAGAIN; losing diagnostic stdout must not change
# the budget verdict. Keep stderr diagnostics and processing failures visible.
cat "$recheck_summary" || true
if [[ "$recheck_verdict" -eq 1 ]]; then
  {
    printf '\n## Failing tests\n\n'
    cat "$failure_list"
    cat "$failure_counts"
  } >> "$budget_summary" || true
fi
if [[ -s "$warning_list" ]]; then
  {
    printf '\n## Infra warnings (starved runner)\n\n'
    cat "$warning_list"
  } >> "$budget_summary" || true
  if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
    while IFS= read -r warning_line; do
      printf '::warning title=Unit timing budget (starved runner)::%s\n' "$warning_line" >&2 || true
    done < "$warning_list"
  fi
fi
cat "$budget_summary" || true
if [[ -n "${BUN_TEST_TIMING_REPORT_DIR:-}" && -d "$BUN_TEST_TIMING_REPORT_DIR" ]]; then
  cp "$budget_summary" "$BUN_TEST_TIMING_REPORT_DIR/unit-timing-budget-summary.md" || {
    echo "Could not copy unit timing summary to $BUN_TEST_TIMING_REPORT_DIR." >&2
  }
fi
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  cat "$budget_summary" >> "$GITHUB_STEP_SUMMARY" || {
    echo "Could not append unit timing summary to $GITHUB_STEP_SUMMARY." >&2
  }
fi
if [[ "$recheck_verdict" -eq 1 ]]; then
  if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
    while IFS= read -r failure_line; do
      if [[ "$failure_line" == FAIL:* && "$failure_line" != 'FAIL: '*test\(s\) ]]; then
        printf '::error::%s\n' "$failure_line" >&2 || true
      fi
    done < "$failure_list"
  fi
  # stderr remains visible when CI stdout is non-blocking or has been closed.
  printf '\nUnit timing budget failures:\n' >&2 || true
  cat "$failure_list" "$failure_counts" >&2 || true
fi
exit "$recheck_verdict"
