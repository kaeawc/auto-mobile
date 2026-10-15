#!/usr/bin/env bash
#
# Print actionable classifications for failed jobs in one pull_request.yml run.

set -euo pipefail

REPO="kaeawc/auto-mobile"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIGNATURES="$SCRIPT_DIR/known-flakes.txt"
RETRY_MARKER='Starting emulator retry attempt 2.'
# shellcheck disable=SC2016 # The jq program intentionally contains jq variables.
FAILURE_CONCLUSIONS_JQ_DEF='def is_failed_conclusion: ((. // "") | ascii_downcase) as $conclusion | ($conclusion == "failure" or $conclusion == "cancelled" or $conclusion == "timed_out" or $conclusion == "startup_failure");'

usage() {
  echo "Usage: scripts/ci/classify-failure.sh <run-id> [--attempt N]" >&2
}

if [[ "$#" -ne 1 && "$#" -ne 3 ]]; then
  usage
  exit 2
fi

attempt_args=()
if [[ "$#" -eq 3 ]]; then
  if [[ "$2" != --attempt || ! "$3" =~ ^[1-9][0-9]*$ ]]; then
    usage
    exit 2
  fi
  attempt_args=(--attempt "$3")
fi

if [[ ! -f "$SIGNATURES" ]]; then
  echo "Known-flake signatures not found: $SIGNATURES" >&2
  exit 1
fi

run_id="$1"
run_json="$(gh run view "$run_id" -R "$REPO" ${attempt_args[@]+"${attempt_args[@]}"} --json jobs,headBranch)"
head_branch="$(jq -r '.headBranch // ""' <<< "$run_json")"

lowercase() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

match_signature() {
  local job_name="$1"
  local annotation_text="$2"
  local job_lc annotation_lc job_pattern message_pattern verdict note
  job_lc="$(lowercase "$job_name")"
  annotation_lc="$(lowercase "$annotation_text")"

  while IFS='|' read -r job_pattern message_pattern verdict note; do
    [[ -n "$job_pattern" ]] || continue
    [[ "$job_pattern" == \#* ]] && continue
    job_pattern="$(lowercase "$job_pattern")"
    message_pattern="$(lowercase "$message_pattern")"
    # shellcheck disable=SC2053 # Signature fields deliberately use shell globs.
    if [[ "$job_lc" == $job_pattern && "$annotation_lc" == $message_pattern ]]; then
      printf '%s — %s' "$verdict" "$note"
      return 0
    fi
  done < "$SIGNATURES"

  printf '%s' 'UNKNOWN — no signature match, investigate'
}

executed_retry_marker_present() {
  local evidence="$1" line normalized in_group=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == *'##[group]Run'* ]]; then
      in_group=1
    fi
    if [[ "$line" == *'##[endgroup]'* ]]; then
      in_group=0
      continue
    fi
    normalized="$line"
    if [[ "$normalized" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[^[:space:]]+Z[[:space:]](.*)$ ]]; then
      normalized="${BASH_REMATCH[1]}"
    fi
    if [[ "$normalized" == "$RETRY_MARKER" && "$in_group" -eq 0 && "$line" != *'echo "'*"$RETRY_MARKER"*'"'* ]]; then
      return 0
    fi
  done <<< "$evidence"
  return 1
}

terminal_attempt_evidence() {
  local evidence="$1"
  local diagnostics_marker='First emulator attempt failed; captured diagnostics follow:'
  local line normalized in_group=0 after_marker=0 terminal=''

  # shellcheck disable=SC2310 # A predicate: a false result is expected control flow.
  if executed_retry_marker_present "$evidence"; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == *'##[group]Run'* ]]; then
        in_group=1
      fi
      if [[ "$line" == *'##[endgroup]'* ]]; then
        in_group=0
        continue
      fi
      normalized="$line"
      if [[ "$normalized" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[^[:space:]]+Z[[:space:]](.*)$ ]]; then
        normalized="${BASH_REMATCH[1]}"
      fi
      if [[ "$normalized" == "$RETRY_MARKER" && "$in_group" -eq 0 && "$line" != *'echo "'*"$RETRY_MARKER"*'"'* ]]; then
        after_marker=1
        terminal=''
      elif [[ "$after_marker" -eq 1 ]]; then
        terminal+="$line"$'\n'
      fi
    done <<< "$evidence"
    printf '%s' "${terminal%$'\n'}"
  elif [[ "$evidence" == *"$diagnostics_marker"* ]]; then
    printf '%s' "$evidence"
  else
    printf '%s' "$evidence"
  fi
}

ambiguous_terminal_attempt() {
  local evidence="$1"
  local diagnostics_marker='First emulator attempt failed; captured diagnostics follow:'

  # shellcheck disable=SC2310 # A predicate: a false result is expected control flow.
  [[ "$evidence" == *"$diagnostics_marker"* ]] \
    && ! executed_retry_marker_present "$evidence"
}

# Gate outcomes are emitted only when every failed upstream job in this run is
# advisory. pull_request.yml no longer has the non-required iOS/Android/Node
# Tests/WebRTC roll-ups; these cases still classify runs recorded before their
# removal. This tells a reader to inspect this report's real upstream rows
# rather than treating a roll-up context as the failing test.
advisory_only_gate() {
  local gate="$1"
  local failures
  failures="$(jq -r "${FAILURE_CONCLUSIONS_JQ_DEF}"$'
    .jobs[]
    | select(.conclusion | is_failed_conclusion)
    | .name
  ' <<< "$run_json")"
  case "$gate" in
    iOS)
      # No advisory lane is inside the iOS gate as of #6943; an iOS aggregator
      # failure can therefore only be caused by a hard dependency.
      return 1
      ;;
    Android)
      [[ -n "$failures" ]] \
        && grep -Eq '^Run (JUnit Runner Emulator|Playground Automobile Emulator)' <<< "$failures" \
        && ! grep -Eq '^(Detect Documentation-Only or SHA256-Only Changes|Build CtrlProxy APK|Build JUnitRunner Library|Build Playground App|SDK Debug Inspector Consumer|JUnit Runner Kotlin Consumer Compatibility|Run JUnit Runner Unit Tests|Run CtrlProxy Unit Tests|Android Emulator Compile Smoke)$' <<< "$failures"
      ;;
    'Node Tests')
      [[ -n "$failures" ]] \
        && grep -Eq '^Node Unit Timing Budget$' <<< "$failures" \
        && ! grep -Eq '^(Node Unit Tests|Node Host Integration Tests)' <<< "$failures"
      ;;
    WebRTC)
      [[ -n "$failures" ]] \
        && grep -Eq '^(Android Device Capture to WHEP|iOS Device Capture to WHEP)' <<< "$failures" \
        && ! grep -Eq '^WebRTC Publisher Integration' <<< "$failures"
      ;;
    *) return 1 ;;
  esac
}

read_log_file() {
  local log_file="$1"
  if [[ ! -s "$log_file" ]]; then
    return 0
  fi
  if unzip -Z1 "$log_file" >/dev/null 2>&1; then
    unzip -p "$log_file" 2>/dev/null || true
  else
    sed -n 'p' "$log_file"
  fi
}

# gh >= 2.101.0 refuses to emit a log body containing terminal escape sequences
# unless --allow-escape-sequences is passed (it exits non-zero and writes
# nothing, even to a file). Job logs are full of ANSI colour codes, so without
# the flag on a new client the log comes back empty and every log-based
# signature silently stops matching. But older gh (< 2.101.0) has no such flag
# and rejects it as "unknown flag" — while needing no flag to emit the log.
#
# Detect support once and record the extra `gh api` args in an array. Keeping the
# `gh api` call at the call site (an external command, not a function invoked in
# the `if`) preserves `set -e` there; this helper is a bare statement that always
# returns 0.
_gh_escape_args_ready=""
_gh_escape_args=()
prepare_gh_escape_args() {
  [[ -n "$_gh_escape_args_ready" ]] && return 0
  # Capture help text, then string-match — do NOT pipe into `grep -q`, whose
  # early close SIGPIPEs `gh` and, under `set -o pipefail`, would misreport the
  # flag as unsupported.
  local gh_api_help
  gh_api_help="$(gh api --help 2>/dev/null || true)"
  if [[ "$gh_api_help" == *"--allow-escape-sequences"* ]]; then
    _gh_escape_args=(--allow-escape-sequences)
  else
    _gh_escape_args=()
  fi
  _gh_escape_args_ready="yes"
  return 0
}

fetch_job_log() {
  local job_id="$1"
  local log_file log_text=''
  log_file="$(mktemp "${TMPDIR:-/tmp}/classify-failure-job-log.XXXXXX")"
  prepare_gh_escape_args
  if gh api ${_gh_escape_args[@]+"${_gh_escape_args[@]}"} "repos/${REPO}/actions/jobs/${job_id}/logs" > "$log_file" 2>/dev/null; then
    log_text="$(read_log_file "$log_file")"
  fi
  rm -f "$log_file"
  printf '%s' "$log_text"
}

diagnose_log_failure() {
  awk '
    function clean(s,    esc) {
      sub(/^\xef\xbb\xbf/, "", s); sub(/\r$/, "", s)
      sub(/^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[^ ]+Z[ ]*/, "", s)
      esc=sprintf("%c", 27); gsub(esc "\\[[0-9;]*m", "", s)
      return s
    }
    function pathnorm(p) {
      gsub(/\\/, "/", p)
      sub(/^\/home\/runner\/work\/[^\/]+\/[^\/]+\//, "", p)
      sub(/^[A-Za-z]:\/a\/[^\/]+\/[^\/]+\//, "", p)
      return p
    }
    function addpart(s) { if (s != "") parts[++np]=s }
    function flush_unhandled(    desc, i, shown) {
      if (!uh) return
      uhcount++
      if (uhpath != "") { uhpath=pathnorm(uhpath); if (!(uhpath in paths)) { paths[uhpath]=1; pathlist[++npath]=uhpath } }
      if (uhfile != "" && !(uhfile in importers)) { importers[uhfile]=1; files[++nfiles]=uhfile }
      if (uherr != "" && firstUnhandledError == "") firstUnhandledError=uherr
      uh=0; uhpath=""; uhfile=""; uherr=""
    }
    function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
    {
      line=clean($0)
      if (line ~ /^##\[group\].*:[[:space:]]*$/) { group=line; sub(/^##\[group\]/,"",group); sub(/:[[:space:]]*$/, "", group) }
      if (line ~ /^# Unhandled error between tests/) { flush_unhandled(); uh=1; uhfile=group; next }
      if (uh) {
        if (line ~ /^error: ENOENT reading "/) { uhpath=line; sub(/^error: ENOENT reading "/,"",uhpath); sub(/".*$/,"",uhpath) }
        else if (line ~ /^error:/ && uherr == "") uherr=line
        if (line ~ /^[-]+$/ && (uhpath != "" || uherr != "")) flush_unhandled()
      }
      if (line ~ /^error:/) { assertion=line; sub(/^error:[[:space:]]*/,"",assertion) }
      if (line ~ /^\(pass\)/ || line ~ /^\(fail\)/) {
        if (line ~ /^\(fail\)/) {
          name=line; sub(/^\(fail\)[[:space:]]*/,"",name); sub(/[[:space:]]+\[[^]]*\][[:space:]]*$/, "", name)
          if (!(name in failseen)) { failseen[name]=1; failures[++nf]=name; ffile[name]=frame; fassert[name]=assertion }
          else if (ffile[name] == "" && frame != "") ffile[name]=frame
          frame=""; assertion=""
        } else { frame=""; assertion="" }
      }
      if (line ~ /^[[:space:]]*at / && line ~ /:[0-9]+:[0-9]+\)?$/) {
        fr=line; sub(/^[[:space:]]*at /,"",fr)
        if (fr ~ /\([^()]*:[0-9]+:[0-9]+\)$/) { sub(/^.*\(/,"",fr); sub(/\)$/,"",fr) }
        sub(/:[0-9]+$/, "", fr)
        if (index(fr,".test.")) frame=pathnorm(fr)
        else if (frame == "") frame=pathnorm(fr)
      }
      if (line ~ /^FAIL: .* shard [0-9]+ exited with status [0-9]+/) { exitline=line }
      if (line == "Segmentation fault" || line == "Killed" || line ~ /terminated by signal/) sigline=line
    }
    END {
      flush_unhandled()
      if (uhcount) {
        desc="bun \"Unhandled error between tests\" x" uhcount ": "
        if (npath) {
          desc=desc "ENOENT reading " pathlist[1]
          for (i=2;i<=npath;i++) desc=desc ", " pathlist[i]
          desc=desc " (missing import target; check filename case on case-sensitive Linux)"
        } else desc=desc (firstUnhandledError != "" ? firstUnhandledError : "error unavailable")
        if (nfiles) { desc=desc " imported by "; shown=nfiles<3?nfiles:3; for(i=1;i<=shown;i++) desc=desc (i==1?"":", ") files[i]; if(nfiles>3) desc=desc " (+" nfiles-3 " more)" }
        addpart(desc)
      }
      if (nf) {
        desc="test failure: "; shown=nf<5?nf:5
        for(i=1;i<=shown;i++) { name=failures[i]; desc=desc (i==1?"":"; ") name; if(ffile[name]!="") { desc=desc " at " ffile[name]; sub(/:[0-9]+:[0-9]+$/, "", desc) } if(fassert[name]!="") desc=desc " (" fassert[name] ")" }
        if(nf>5) desc=desc " (+" nf-5 " more)"; addpart(desc)
      }
      if (exitline != "") {
        match(exitline,/shard [0-9]+/); shard=substr(exitline,RSTART+6,RLENGTH-6); match(exitline,/status [0-9]+/); status=substr(exitline,RSTART+7,RLENGTH-7)+0
        if(status>128 && status!=124) { n=status-128; sig="SIG" n; if(n==1)sig="SIGHUP"; else if(n==2)sig="SIGINT"; else if(n==6)sig="SIGABRT"; else if(n==9)sig="SIGKILL"; else if(n==11)sig="SIGSEGV"; else if(n==15)sig="SIGTERM"; addpart("shard " shard " killed by signal " sig " (status " status ")") }
        else if(status>=1 && status<=127 && np>0) addpart("shard " shard " exited with status " status " (not a signal kill)")
      }
      if(sigline!="" && (exitline == "" || status>128 || status==124 || status==0 || status>127)) addpart("signal evidence in log: " sigline)
      for(i=1;i<=np;i++) printf "%s%s", (i==1?"":"; "), parts[i]
    }
  ' <<< "$1"
}

display_annotation() {
  awk 'BEGIN { ORS="" } { if (NR>1) s=s " "; s=s $0 } END { gsub(/[[:space:]]+/, " ", s); sub(/^ /,"",s); sub(/ $/,"",s); if (length(s)>200) s=substr(s,1,197) "..."; print s }' <<< "$1"
}

fetch_artifact_logs() {
  local job_name="$1"
  local matrix_suffix artifact_name artifacts artifact_id artifact_file artifact_text=''
  if [[ "$job_name" != "Node TypeScript Build and Test ("* ]]; then
    return 0
  fi
  if [[ ! "$job_name" =~ \(([^\(\)]*)\)$ ]]; then
    return 0
  fi
  matrix_suffix="$(lowercase "${BASH_REMATCH[1]}")"
  matrix_suffix="${matrix_suffix// /-}"
  artifact_name="mcp-build-test-logs-${matrix_suffix}"
  if ! artifacts="$(gh api --paginate --slurp "repos/${REPO}/actions/runs/${run_id}/artifacts?per_page=100" 2>/dev/null)"; then
    return 0
  fi
  while IFS= read -r artifact_id; do
    [[ -n "$artifact_id" ]] || continue
    artifact_file="$(mktemp "${TMPDIR:-/tmp}/classify-failure-artifact-log.XXXXXX")"
    if gh api "repos/${REPO}/actions/artifacts/${artifact_id}/zip" > "$artifact_file" 2>/dev/null; then
      artifact_text+="$(read_log_file "$artifact_file")"
    fi
    rm -f "$artifact_file"
  done < <(
    jq -r --arg artifact_name "$artifact_name" '[.[].artifacts[]? | select(.name == $artifact_name) | .id] | .[]' <<< "$artifacts"
  )
  printf '%s' "$artifact_text"
}

failed_count=0
while IFS=$'\t' read -r job_id job_name steps; do
  [[ -n "$job_id" ]] || continue
  failed_count=$((failed_count + 1))
  annotations=''
  if ! annotations="$(gh api --paginate --slurp "repos/${REPO}/check-runs/${job_id}/annotations?per_page=100" 2>/dev/null)"; then
    annotations='[[]]'
  fi
  annotation_text="$(jq -r '[.[][]? | (.message // .raw_details // "")] | map(select(length > 0)) | join("; ")' <<< "$annotations")"
  if [[ -z "$annotation_text" ]]; then
    annotation_text='none'
  fi
  display_annotation_text="$(display_annotation "$annotation_text")"
  log_text="$(fetch_job_log "$job_id")"
  if [[ -z "$log_text" ]]; then
    log_text="$(fetch_artifact_logs "$job_name")"
  fi

  # shellcheck disable=SC2310 # A non-match is expected classifier control flow.
  if advisory_only_gate "$job_name"; then
    verdict='CHECK-UPSTREAM-FIRST — aggregator is red because of an advisory (non-required) lane; inspect the upstream rows above before rerunning or filing an issue'
  elif [[ "${head_branch} ${annotation_text} ${log_text}" == *"$RETRY_MARKER"* ]] \
    && ! executed_retry_marker_present "${head_branch} ${annotation_text} ${log_text}"; then
    verdict='UNKNOWN — retry attempt never executed; echoed retry marker is not terminal-attempt evidence'
  elif ambiguous_terminal_attempt "${head_branch} ${annotation_text} ${log_text}"; then
    verdict='UNKNOWN — log predates the retry marker; attempt-one diagnostics are not authoritative for the terminal attempt'
  else
    evidence="$(terminal_attempt_evidence "${head_branch} ${annotation_text} ${log_text}")"
    verdict="$(match_signature "$job_name" "$evidence")"
    if [[ "$verdict" == 'UNKNOWN — no signature match, investigate' ]]; then
      diagnosis="$(diagnose_log_failure "$log_text")"
      if [[ -n "$diagnosis" ]]; then verdict="INVESTIGATE — $diagnosis"; fi
    fi
  fi

  printf '%s → %s → %s → %s\n' "$job_name" "${steps:-none}" "$display_annotation_text" "$verdict"
done < <(
  jq -r "${FAILURE_CONCLUSIONS_JQ_DEF}"$'
    .jobs[]
    | select(.conclusion | is_failed_conclusion)
    | [(.databaseId // .id // ""), .name, ([.steps[]? | select(.conclusion | is_failed_conclusion) | .name] | join(", "))]
    | @tsv
  ' <<< "$run_json"
)

if [[ "$failed_count" -eq 0 ]]; then
  echo "No failed or cancelled jobs in run ${run_id}."
fi
