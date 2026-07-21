#!/usr/bin/env bash
#
# measure-ci.sh — reproducible CI failure-rate and step-duration measurement
# (issue #4122).
#
# Every recent CI judgment call ("is the iOS rollup safe to require?",
# "what should timeout-minutes be?") needed the same three numbers, and every
# time they were re-derived by hand and thrown away. This script makes that
# measurement a command.
#
# Over a bounded window of workflow runs it reports:
#
#   1. Per-job outcome tally      — executed / passed / failed / skipped /
#                                   cancelled, ranked by failure rate.
#   2. Per-step duration spread   — min / median / p90 / p95 / max, keyed by
#                                   (job, step name, ORDINAL). The ordinal is
#                                   load-bearing: "all 9 boots >= 300s were the
#                                   THIRD boot" is invisible under a naive
#                                   group-by-name.
#   3. Rerun-success rate         — a job that failed and then passed unchanged
#                                   on a later attempt of the same head SHA.
#                                   The cleanest flake signal available.
#   4. Optional log sentinel      — fraction of matching jobs whose log contains
#                                   a pattern (opt-in; the only path that reads
#                                   log text rather than the jobs API).
#
# The script is two separable layers:
#
#   fetch      gh -> a normalized "bundle" JSON document (--fetch-only, --cache)
#   aggregate  bundle JSON -> summary or --json (--from-file)
#
# so the aggregation math is testable offline against fixtures with no API
# access at all (see test/bats/measure-ci.bats).
#
# Usage:
#   scripts/ci/measure-ci.sh --limit 50
#   scripts/ci/measure-ci.sh --limit 100 --json > window-a.json
#   scripts/ci/measure-ci.sh --fetch-only --limit 100 > bundle.json
#   scripts/ci/measure-ci.sh --from-file bundle.json --json
#   scripts/ci/measure-ci.sh --limit 100 --cache /tmp/ci.json      # resumable
#   scripts/ci/measure-ci.sh --limit 40 --sentinel 'Status=4294967295' \
#                            --sentinel-job 'XCTestRunner'
#
# Notes on API usage:
#   * `gh api --paginate` over all workflow runs hangs for minutes and returns
#     nothing useful. This script pages explicitly with a hard cap instead.
#   * One `gh run list` call plus one jobs call per run (a second page only when
#     a run has >100 jobs). A 100-run window is ~101 calls.
#   * --max-runs is a loud ceiling: asking for more than it allows is an error,
#     not a silent truncation.

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
WORKFLOW="Pull Request"
LIMIT=50
MAX_RUNS=200
REPO=""
BRANCH=""
FROM_FILE=""
CACHE_FILE=""
FETCH_ONLY=0
JSON_OUTPUT=0
TOP_STEPS=25
STEP_FILTER=""
JOB_FILTER=""
MIN_SAMPLES=3
SENTINEL=""
SENTINEL_JOB=""
# Hard cap on jobs-API pages per run (100 jobs/page). 5 pages = 500 jobs.
MAX_JOB_PAGES=5
# Set on the fetch path only (main); declared here so `set -u` and shellcheck agree.
API_PREFIX=""
# Scratch dir for the fetch layer; created in main, removed by an EXIT trap.
WORK_DIR=""

usage() {
  cat >&2 << EOF
Usage: ${SCRIPT_NAME} [options]

Window selection (fetch layer):
  --workflow NAME     Workflow name to measure (default: "${WORKFLOW}")
  --limit N           Number of most recent runs to fetch (default: ${LIMIT})
  --max-runs N        Hard ceiling on --limit (default: ${MAX_RUNS}); exceeding
                      it is a loud error, not a silent truncation
  --repo OWNER/REPO   Repository (default: gh's current repo)
  --branch NAME       Restrict to one head branch

Layer control:
  --fetch-only        Fetch and print the normalized bundle JSON, then exit
  --from-file PATH    Aggregate a pre-fetched bundle instead of calling the API
                      ("-" reads stdin). No network access.
  --cache PATH        Read/write the bundle at PATH; runs already present are
                      reused and only missing runs are fetched (resume)

Output:
  --json              Emit the aggregate as JSON (default: human summary)
  --top N             Steps to show in the human summary (default: ${TOP_STEPS})
  --min-samples N     Hide step keys with fewer than N samples (default: ${MIN_SAMPLES})
  --step-filter RE    Only report steps whose name matches this regex
  --job-filter RE     Only report jobs whose name matches this regex

Log sentinel (opt-in; the only log-text path):
  --sentinel RE       Count jobs whose log contains this regex
  --sentinel-job RE   Restrict sentinel log fetches to jobs matching this regex
                      (strongly recommended: one extra API call per job)

  -h, --help          Show this help
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" > /dev/null 2>&1 || die "required command not found: $1"
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
need_value() {
  [ "$2" -ge 2 ] || die "$1 requires a value"
}

require_positive_int() {
  case "$2" in
    '' | *[!0-9]*) die "$1 expects a positive integer, got: $2" ;;
  esac
  [ "$2" -gt 0 ] || die "$1 expects a positive integer, got: $2"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --workflow)
      need_value "$1" "$#"
      WORKFLOW="$2"
      shift 2
      ;;
    --limit)
      need_value "$1" "$#"
      require_positive_int "$1" "$2"
      LIMIT="$2"
      shift 2
      ;;
    --max-runs)
      need_value "$1" "$#"
      require_positive_int "$1" "$2"
      MAX_RUNS="$2"
      shift 2
      ;;
    --repo)
      need_value "$1" "$#"
      REPO="$2"
      shift 2
      ;;
    --branch)
      need_value "$1" "$#"
      BRANCH="$2"
      shift 2
      ;;
    --from-file)
      need_value "$1" "$#"
      FROM_FILE="$2"
      shift 2
      ;;
    --cache)
      need_value "$1" "$#"
      CACHE_FILE="$2"
      shift 2
      ;;
    --fetch-only)
      FETCH_ONLY=1
      shift
      ;;
    --json)
      JSON_OUTPUT=1
      shift
      ;;
    --top)
      need_value "$1" "$#"
      require_positive_int "$1" "$2"
      TOP_STEPS="$2"
      shift 2
      ;;
    --min-samples)
      need_value "$1" "$#"
      require_positive_int "$1" "$2"
      MIN_SAMPLES="$2"
      shift 2
      ;;
    --step-filter)
      need_value "$1" "$#"
      STEP_FILTER="$2"
      shift 2
      ;;
    --job-filter)
      need_value "$1" "$#"
      JOB_FILTER="$2"
      shift 2
      ;;
    --sentinel)
      need_value "$1" "$#"
      SENTINEL="$2"
      shift 2
      ;;
    --sentinel-job)
      need_value "$1" "$#"
      SENTINEL_JOB="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown argument: $1"
      ;;
  esac
done

require_cmd jq

if [ "$LIMIT" -gt "$MAX_RUNS" ]; then
  die "--limit ${LIMIT} exceeds --max-runs ${MAX_RUNS}. This window would cost ~$((LIMIT + 1)) API calls; raise --max-runs deliberately if that is intended."
fi

if [ -n "$FROM_FILE" ] && [ "$FETCH_ONLY" -eq 1 ]; then
  die "--from-file and --fetch-only are mutually exclusive"
fi

# ---------------------------------------------------------------------------
# Fetch layer
#
# Everything below this banner talks to the network. Its sole output is a
# "bundle" document:
#
#   { "meta": { repo, workflow, limit, branch, fetched_at },
#     "runs": [ { id, number, head_sha, head_branch, event, status, conclusion,
#                 run_attempt, created_at, updated_at,
#                 jobs: [ { id, name, run_attempt, status, conclusion,
#                           started_at, completed_at, sentinel (bool|null),
#                           steps: [ { name, number, status, conclusion,
#                                      started_at, completed_at } ] } ] } ] }
#
# The aggregation layer consumes exactly this and nothing else.
# ---------------------------------------------------------------------------

gh_json() {
  # Single-page gh api call; caller supplies the full path.
  gh api -H "Accept: application/vnd.github+json" "$@"
}

fetch_run_jobs() {
  # $1 = run id, $2 = output file. Writes a JSON array of raw job objects.
  #
  # Pages are accumulated through files, never through a shell variable: a
  # 60-run window's job payload blows past ARG_MAX the moment it reaches a
  # `jq --argjson`, and the failure mode is a late, opaque
  # "Argument list too long".
  local run_id="$1"
  local out_file="$2"
  local page_dir="${WORK_DIR}/pages-${run_id}"
  local page=1
  local total=0
  local fetched=0

  mkdir -p "$page_dir"
  while [ "$page" -le "$MAX_JOB_PAGES" ]; do
    gh_json "${API_PREFIX}/actions/runs/${run_id}/jobs?filter=all&per_page=100&page=${page}" \
      > "${page_dir}/${page}.json"
    total="$(jq -r '.total_count // 0' "${page_dir}/${page}.json")"
    fetched=$((fetched + $(jq '(.jobs // []) | length' "${page_dir}/${page}.json")))
    if [ "$fetched" -ge "$total" ]; then
      break
    fi
    page=$((page + 1))
  done

  if [ "$fetched" -lt "$total" ]; then
    echo "WARN: run ${run_id} has ${total} jobs, capped at ${fetched} (${MAX_JOB_PAGES} pages)" >&2
  fi

  jq -c -s 'map(.jobs // []) | add // []' "${page_dir}"/*.json > "$out_file"
  rm -rf "$page_dir"
}

normalize_jobs() {
  # stdin: raw jobs array -> stdout: normalized jobs array.
  jq -c '[ .[] | {
    id: .id,
    name: .name,
    run_attempt: (.run_attempt // 1),
    status: .status,
    conclusion: .conclusion,
    started_at: .started_at,
    completed_at: .completed_at,
    sentinel: null,
    steps: [ (.steps // [])[] | {
      name: .name,
      number: .number,
      status: .status,
      conclusion: .conclusion,
      started_at: .started_at,
      completed_at: .completed_at
    } ]
  } ]'
}

fetch_sentinel_flags() {
  # $1 = normalized jobs file, updated in place: .sentinel becomes true/false
  # for jobs whose name matches SENTINEL_JOB (and stays null otherwise).
  #
  # This is the ONLY path in the script that reads log text. Everything else
  # comes from the structured jobs API.
  local jobs_file="$1"
  [ -n "$SENTINEL" ] || return 0

  local ids job_id hit log_file="${WORK_DIR}/sentinel.log"
  ids="$(jq -r --arg re "${SENTINEL_JOB:-.}" '.[] | select(.name | test($re)) | .id' "$jobs_file")"

  for job_id in $ids; do
    hit=false
    # A 404/410 here means the logs expired; treat that as "not observed"
    # rather than failing the whole window.
    if gh api "${API_PREFIX}/actions/jobs/${job_id}/logs" > "$log_file" 2> /dev/null; then
      if grep -Eq -- "$SENTINEL" "$log_file"; then
        hit=true
      fi
    else
      echo "WARN: could not fetch logs for job ${job_id} (expired?)" >&2
      continue
    fi
    jq -c --argjson id "$job_id" --argjson hit "$hit" \
      'map(if .id == $id then .sentinel = $hit else . end)' "$jobs_file" \
      > "${jobs_file}.tmp"
    mv "${jobs_file}.tmp" "$jobs_file"
  done
}

fetch_bundle() {
  # $1 = output bundle file.
  require_cmd gh

  local out_bundle="$1"
  local runs_file="${WORK_DIR}/runs.json"
  local run_file="${WORK_DIR}/run.json"
  local jobs_file="${WORK_DIR}/jobs.json"
  local raw_jobs_file="${WORK_DIR}/jobs-raw.json"
  # Newline-delimited JSON: one completed run object per line, slurped at the
  # end. Appending to a file keeps the loop O(n) instead of re-serializing the
  # whole accumulator on every iteration.
  local out_jsonl="${WORK_DIR}/out.jsonl"
  : > "$out_jsonl"

  local run_args=()
  run_args+=(--workflow "$WORKFLOW" --limit "$LIMIT")
  [ -n "$REPO" ] && run_args+=(--repo "$REPO")
  [ -n "$BRANCH" ] && run_args+=(--branch "$BRANCH")

  echo "Fetching up to ${LIMIT} \"${WORKFLOW}\" runs..." >&2
  gh run list "${run_args[@]}" \
    --json databaseId,number,headSha,headBranch,event,status,conclusion,attempt,createdAt,updatedAt \
    | jq -c '[ .[] | {
        id: .databaseId,
        number: .number,
        head_sha: .headSha,
        head_branch: .headBranch,
        event: .event,
        status: .status,
        conclusion: .conclusion,
        run_attempt: (.attempt // 1),
        created_at: .createdAt,
        updated_at: .updatedAt,
        jobs: []
      } ]' > "$runs_file"

  local have_cache=0
  if [ -n "$CACHE_FILE" ] && [ -f "$CACHE_FILE" ]; then
    have_cache=1
    echo "Cache: $(jq '(.runs // []) | length' "$CACHE_FILE") runs available for reuse from ${CACHE_FILE}" >&2
  fi

  local run_ids run_id total idx=0 attempt reused=0
  run_ids="$(jq -r '.[].id' "$runs_file")"
  total="$(jq 'length' "$runs_file")"

  for run_id in $run_ids; do
    idx=$((idx + 1))
    jq -c --argjson id "$run_id" '.[] | select(.id == $id)' "$runs_file" > "$run_file"
    attempt="$(jq '.run_attempt' "$run_file")"

    # Resume: a cached run is reused only when it already carries jobs AND its
    # attempt count still matches, so a run re-run since the last fetch is
    # re-fetched rather than silently served stale.
    if [ "$have_cache" -eq 1 ] && jq -e -c --argjson id "$run_id" --argjson attempt "$attempt" \
      '(.runs // []) | map(select(.id == $id and (.jobs | length) > 0 and .run_attempt == $attempt))[0] // empty' \
      "$CACHE_FILE" >> "$out_jsonl"; then
      reused=$((reused + 1))
      continue
    fi

    echo "  [${idx}/${total}] run ${run_id}" >&2
    fetch_run_jobs "$run_id" "$raw_jobs_file"
    normalize_jobs < "$raw_jobs_file" > "$jobs_file"
    fetch_sentinel_flags "$jobs_file"
    jq -c --slurpfile jobs "$jobs_file" '. + { jobs: $jobs[0] }' "$run_file" >> "$out_jsonl"
  done

  [ "$reused" -gt 0 ] && echo "Cache: reused ${reused} run(s)" >&2

  jq -n \
    --arg repo "${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2> /dev/null || echo '')}" \
    --arg workflow "$WORKFLOW" \
    --arg branch "$BRANCH" \
    --arg sentinel "$SENTINEL" \
    --argjson limit "$LIMIT" \
    --slurpfile runs "$out_jsonl" \
    '{ meta: { repo: $repo, workflow: $workflow, branch: (if $branch == "" then null else $branch end),
               limit: $limit, sentinel: (if $sentinel == "" then null else $sentinel end),
               fetched_at: (now | todateiso8601) },
       runs: $runs }' > "$out_bundle"
}

# ---------------------------------------------------------------------------
# Aggregation layer
#
# Pure jq over a bundle. No network, no shell state. This is what BATS drives.
# ---------------------------------------------------------------------------

# Quoted heredoc: every $ inside is a jq variable, and shfmt leaves heredoc
# bodies untouched (it rewrites \( ... ) sequences inside ordinary strings).
JQ_AGGREGATE="$(
  cat << 'JQ_PROGRAM'
# --- helpers ---------------------------------------------------------------

# GitHub emits RFC3339 "Z" timestamps; strip any fractional seconds defensively.
def ts: if . == null then null else (sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) end;

# Nearest-rank percentile over an ASCENDING-sorted array.
#   index = ceil(p/100 * n), 1-based, clamped to [1, n]
# Deliberately NOT interpolated: with n=10, p90 is the 9th value, and that is
# the value the pinning test in test/bats/measure-ci.bats asserts.
def pct($p): . as $a | ($a | length) as $n
  | if $n == 0 then null
    else $a[ ([ ([ ((($p / 100) * $n) | ceil), 1 ] | max), $n ] | min) - 1 ]
    end;

def round1: (. * 10 | round) / 10;
def round3: (. * 1000 | round) / 1000;

# --- flattened records -----------------------------------------------------

[ .runs[] | . as $run | ($run.jobs // [])[] | { run: $run, job: . } ] as $jobrecs

# Every executed step, tagged with the ordinal of its name WITHIN its job.
# Steps are ordered by .number first so the ordinal is positional, and the
# ordinal (not .number) is the key: inserting an unrelated step earlier in the
# job shifts .number but must not renumber "boot #3".
| [ $jobrecs[]
    | .job as $job | .run as $run
    | ($job.steps // [] | sort_by(.number)) as $steps
    | range(0; $steps | length) as $i
    | $steps[$i] as $s
    | { job: $job.name,
        step: $s.name,
        ordinal: ( [ $steps[0:$i][] | select(.name == $s.name) ] | length ) + 1,
        conclusion: $s.conclusion,
        run_id: $run.id,
        run_attempt: $job.run_attempt,
        started: ($s.started_at | ts),
        completed: ($s.completed_at | ts) }
  ] as $steprecs

# --- 1. per-job outcome tally ---------------------------------------------

| ( $jobrecs
    | map(.job)
    | select(length >= 0)
    | group_by(.name)
    | map( (map(select(.conclusion == "skipped")) | length) as $skipped
         | { job: .[0].name,
             total: length,
             executed: (length - $skipped),
             passed: (map(select(.conclusion == "success")) | length),
             failed: (map(select(.conclusion == "failure")) | length),
             skipped: $skipped,
             cancelled: (map(select(.conclusion == "cancelled")) | length),
             other: (map(select(.conclusion as $c
                          | ($c == null) or ([ "success","failure","skipped","cancelled" ]
                                             | index($c) | not))) | length) }
         | .failure_rate = (if .executed > 0 then (.failed / .executed | round3) else 0 end) )
    | sort_by(-.failure_rate, -.failed, .job) ) as $jobs

# --- 2. per-step duration distribution ------------------------------------
# Skipped steps are excluded (they have no meaningful duration); success,
# failure and cancelled are all kept, because a killed step IS the tail.

| ( $steprecs
    | map(select(.conclusion != "skipped" and .started != null and .completed != null))
    | map(. + { seconds: (.completed - .started) })
    | map(select(.seconds >= 0))
    | group_by([ .job, .step, .ordinal ])
    | map( (map(.seconds) | sort) as $d
         | { job: .[0].job,
             step: .[0].step,
             ordinal: .[0].ordinal,
             samples: ($d | length),
             failed: (map(select(.conclusion == "failure")) | length),
             min: ($d | pct(0) | round1),
             median: ($d | pct(50) | round1),
             p90: ($d | pct(90) | round1),
             p95: ($d | pct(95) | round1),
             max: ($d | pct(100) | round1) } )
    | sort_by(-.p95, -.max) ) as $steps

# --- 3. rerun-success rate -------------------------------------------------
# A "unit" is (head SHA, job name). It is retried when the same unit has a
# failing attempt and at least one later attempt. It is a rerun-success when the
# highest attempt succeeded — i.e. the code was unchanged and it passed anyway.

| ( $jobrecs
    | map({ sha: .run.head_sha, job: .job.name,
            attempt: .job.run_attempt, conclusion: .job.conclusion })
    | group_by([ .sha, .job ])
    | map(sort_by(.attempt))
    | map(select( (map(.attempt) | unique | length) > 1
                  and (any(.[]; .conclusion == "failure")) ))
    | map({ sha: .[0].sha, job: .[0].job,
            attempts: (map(.attempt) | unique | length),
            final: (sort_by(.attempt) | last | .conclusion),
            rerun_passed: ((sort_by(.attempt) | last | .conclusion) == "success") }) ) as $retried

| ( $retried
    | group_by(.job)
    | map({ job: .[0].job,
            retried: length,
            rerun_passed: (map(select(.rerun_passed)) | length),
            rerun_success_rate: ((map(select(.rerun_passed)) | length) / length | round3) })
    | sort_by(-.retried, .job) ) as $rerun_by_job

# --- 4. log sentinel (opt-in) ---------------------------------------------

| ( $jobrecs | map(.job) | map(select(.sentinel != null)) ) as $sentinel_jobs
| ( if ($sentinel_jobs | length) == 0 then null
    else { pattern: ($meta.sentinel // null),
           observed: ($sentinel_jobs | length),
           hits: ($sentinel_jobs | map(select(.sentinel)) | length),
           hit_rate: (($sentinel_jobs | map(select(.sentinel)) | length)
                      / ($sentinel_jobs | length) | round3) }
    end ) as $sentinel

# --- assembly --------------------------------------------------------------

| { window: {
      repo: $meta.repo, workflow: $meta.workflow, branch: $meta.branch,
      runs: (.runs | length),
      job_records: ($jobrecs | length),
      step_records: ($steprecs | length),
      reruns_observed: (.runs | map(select(.run_attempt > 1)) | length),
      oldest_run_at: (.runs | map(.created_at) | sort | first),
      newest_run_at: (.runs | map(.created_at) | sort | last),
      fetched_at: $meta.fetched_at },
    jobs: ($jobs | map(select(.job | test($jobFilter)))),
    steps: ($steps | map(select(.samples >= $minSamples
                                and (.step | test($stepFilter))
                                and (.job | test($jobFilter))))),
    reruns: { retried_units: ($retried | length),
              rerun_passed: ($retried | map(select(.rerun_passed)) | length),
              rerun_success_rate: (if ($retried | length) > 0
                                   then ($retried | map(select(.rerun_passed)) | length)
                                        / ($retried | length) | round3
                                   else null end),
              by_job: $rerun_by_job,
              units: $retried },
    sentinel: $sentinel }
JQ_PROGRAM
)"

aggregate() {
  # stdin: bundle JSON -> stdout: aggregate JSON
  jq \
    --arg stepFilter "${STEP_FILTER:-.}" \
    --arg jobFilter "${JOB_FILTER:-.}" \
    --argjson minSamples "$MIN_SAMPLES" \
    '(.meta // {}) as $meta | '"$JQ_AGGREGATE"
}

# ---------------------------------------------------------------------------
# Human-readable rendering (pure: aggregate JSON in, text out)
# ---------------------------------------------------------------------------

render() {
  jq -r --argjson top "$TOP_STEPS" '
    def pad($n): tostring | . + (" " * ($n - length));
    def lpad($n): tostring | (" " * ($n - length)) + .;
    def pctstr: if . == null then "n/a" else ((. * 1000 | round) / 10 | tostring) + "%" end;

    "== CI measurement: \(.window.workflow) @ \(.window.repo // "?") ==",
    "Runs: \(.window.runs)   job records: \(.window.job_records)   step records: \(.window.step_records)",
    "Window: \(.window.oldest_run_at // "?") .. \(.window.newest_run_at // "?")",
    "",
    "-- Per-job outcomes (ranked by failure rate) --",
    "  \("rate" | lpad(7))  \("exec" | lpad(5)) \("pass" | lpad(5)) \("fail" | lpad(5)) \("skip" | lpad(5)) \("canc" | lpad(5))  job",
    ( .jobs[]
      | "  \(.failure_rate | pctstr | lpad(7))  \(.executed | lpad(5)) \(.passed | lpad(5)) \(.failed | lpad(5)) \(.skipped | lpad(5)) \(.cancelled | lpad(5))  \(.job)" ),
    "",
    "-- Step durations, seconds (ranked by p95; #N = Nth occurrence of that step in the job) --",
    "  \("n" | lpad(4)) \("min" | lpad(7)) \("med" | lpad(7)) \("p90" | lpad(7)) \("p95" | lpad(7)) \("max" | lpad(7))  step",
    ( .steps[0:$top][]
      | "  \(.samples | lpad(4)) \(.min | lpad(7)) \(.median | lpad(7)) \(.p90 | lpad(7)) \(.p95 | lpad(7)) \(.max | lpad(7))  \(.job) / \(.step) #\(.ordinal)" ),
    ( if (.steps | length) > $top then "  ... \((.steps | length) - $top) more step keys (raise --top)" else empty end ),
    "",
    "-- Rerun success (same head SHA failed, then passed on a later attempt) --",
    "  retried (sha, job) units: \(.reruns.retried_units)",
    "  passed on rerun:          \(.reruns.rerun_passed)   rate: \(.reruns.rerun_success_rate | pctstr)",
    ( .reruns.by_job[]
      | "    \(.rerun_passed)/\(.retried)  \(.rerun_success_rate | pctstr | lpad(6))  \(.job)" ),
    ( if .sentinel == null then empty
      else "",
           "-- Log sentinel --",
           "  pattern: \(.sentinel.pattern // "?")",
           "  \(.sentinel.hits)/\(.sentinel.observed) jobs matched  (\(.sentinel.hit_rate | pctstr))"
      end )
  '
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  # Bundles reach tens of megabytes for a 100-run window, so they live in a
  # file and are piped, never held in a shell variable or passed as an argv
  # (jq --argjson on a large bundle dies with "Argument list too long").
  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/measure-ci.XXXXXX")"
  trap 'rm -rf "$WORK_DIR"' EXIT
  local bundle_file="${WORK_DIR}/bundle.json"

  if [ -n "$FROM_FILE" ]; then
    if [ "$FROM_FILE" = "-" ]; then
      cat > "$bundle_file"
    else
      [ -f "$FROM_FILE" ] || die "bundle file not found: $FROM_FILE"
      cp -- "$FROM_FILE" "$bundle_file"
    fi
    jq -e 'has("runs") and (.runs | type == "array")' "$bundle_file" > /dev/null 2>&1 \
      || die "bundle is not valid JSON with a .runs array: $FROM_FILE"
  else
    # API_PREFIX is only needed on the fetch path.
    if [ -z "$REPO" ]; then
      require_cmd gh
      REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
    fi
    API_PREFIX="/repos/${REPO}"
    fetch_bundle "$bundle_file"
    if [ -n "$CACHE_FILE" ]; then
      cp "$bundle_file" "$CACHE_FILE"
      echo "Cache: wrote ${CACHE_FILE}" >&2
    fi
  fi

  if [ "$FETCH_ONLY" -eq 1 ]; then
    cat "$bundle_file"
    return 0
  fi

  if [ "$JSON_OUTPUT" -eq 1 ]; then
    aggregate < "$bundle_file"
  else
    aggregate < "$bundle_file" | render
  fi
}

main
