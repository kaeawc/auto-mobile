#!/usr/bin/env bats
#
# Guards issue #4082: the downstream steps of `ios-xctest-runner-simulator-tests`
# use `if: !cancelled()` so they run even when an earlier step in the job failed
# (deliberate independence from the CtrlProxy UI test that precedes them). But a bare
# `!cancelled()` also bypasses a
# SHARED-prerequisite failure (XcodeGen drift check / CtrlProxy build), so the
# 26.5 block ran on a broken build and emitted misleading secondary failures
# (e.g. a spurious downstream simulator-test failure whose
# real cause was the drift check).
#
# The fix gates every such step additionally on the shared CtrlProxy build
# succeeding. This test pins both halves of that invariant.

WORKFLOW=".github/workflows/pull_request.yml"

@test "the shared CtrlProxy build step carries the build-ctrlproxy id" {
  # The step the 26.5 leg keys off of must exist and be identified.
  run grep -A1 'name: "Build CtrlProxy iOS for Testing"' "$WORKFLOW"
  [ "$status" -eq 0 ]
  [[ "$output" == *"id: build-ctrlproxy"* ]]
}

@test "no step uses a bare 'if: !cancelled()' without gating on the shared build" {
  # A bare !cancelled() is the anti-pattern: it runs after ANY failure, including
  # a doomed shared prerequisite. Every !cancelled() must be conjoined with the
  # build-outcome guard.
  bare="$(grep -n 'if: ${{ !cancelled() }}' "$WORKFLOW" || true)"
  if [ -n "$bare" ]; then
    echo "Bare '!cancelled()' conditions found (must gate on build-ctrlproxy):" >&2
    echo "$bare" >&2
  fi
  [ -z "$bare" ]
}

# Print the active `if:` value for a named step, or nothing when the step has none.
#
# No positional anchor: #4114 removed the leg's redundant "Select Xcode 26.5" and
# "Ensure iOS Simulator runtime (Xcode 26.5)", which were the only duplicated step
# names in this job. Every step name is now unique, so a plain by-name lookup
# cannot match the wrong occurrence. The uniqueness test below is what keeps that
# true -- if a duplicate is ever reintroduced, this lookup would silently resolve
# to the first one.
#
# awk, not sed -- BSD sed lacks the range forms this needs. A step block runs from
# its `- name: "<step>"` line to the next step start or a step-indent comment.

step_if_condition() {
  awk -v want="      - name: \"$1\"" '
    $0 == want { inblock = 1; next }
    inblock && /^      [-#]/ { exit }
    inblock && /^        if:/ {
      sub(/^        if:[[:space:]]*/, "")
      print
      exit
    }
  ' "$WORKFLOW"
}

# Every downstream step that must not run on a doomed shared prerequisite.
# Named explicitly: a global count cannot tell "each of these is guarded" from
# "the total happens to add up", so one step could lose its guard while an
# unrelated step gained one and the suite would stay green. Keep this as an
# array rather than a process substitution: BATS' parallel runner can otherwise
# terminate the short-lived producer while cleaning up the test process group.
xcode_265_leg_steps=(
  "Ensure AutoMobile daemon ready (Xcode 26.5)"
  "Warm up iOS CtrlProxy (Xcode 26.5)"
  "Run iOS navigation graph Simulator workflow"
)

@test "no step name is duplicated in the XCTestRunner job" {
  # The by-name lookup above is only safe while names are unique. A duplicate
  # would resolve to the FIRST occurrence -- historically the job-initial,
  # unguarded "Select Xcode 26.5" -- and silently assert against the wrong step.
  # This replaces the old anchor-uniqueness guard (#4115): the anchor existed
  # solely to work around the duplication that #4114 removed.
  dupes="$(awk '
    /^  ios-xctest-runner-simulator-tests:/ { injob = 1; next }
    injob && /^  [a-z][a-z0-9_-]*:$/ { exit }
    injob && /^      - name: "/ { print }
  ' "$WORKFLOW" | sort | uniq -d)"

  if [ -n "$dupes" ]; then
    echo "Duplicated step names (by-name lookup would resolve to the first):" >&2
    echo "$dupes" >&2
  fi
  [ -z "$dupes" ]
}

@test "every 26.5-leg step individually gates on steps.build-ctrlproxy.outcome == success" {
  local offenders=""
  for step in "${xcode_265_leg_steps[@]}"; do
    condition="$(step_if_condition "$step")"
    if [ -z "$condition" ]; then
      offenders="${offenders}${step}: no 'if:' condition"$'\n'
    elif [[ "$condition" != *"steps.build-ctrlproxy.outcome == 'success'"* ]]; then
      offenders="${offenders}${step}: ${condition}"$'\n'
    fi
  done

  if [ -n "$offenders" ]; then
    echo "26.5-leg steps missing the shared-build guard:" >&2
    echo "$offenders" >&2
  fi
  [ -z "$offenders" ]
}

@test "every 26.5-leg step still respects cancellation" {
  # The other half of the condition: a cancelled workflow must skip these steps.
  local offenders=""
  for step in "${xcode_265_leg_steps[@]}"; do
    condition="$(step_if_condition "$step")"
    if [[ "$condition" != *"!cancelled()"* ]] || [[ "$condition" == *"||"* ]]; then
      offenders="${offenders}${step}: ${condition:-<none>}"$'\n'
    fi
  done

  if [ -n "$offenders" ]; then
    echo "26.5-leg steps that do not skip on cancellation:" >&2
    echo "$offenders" >&2
  fi
  [ -z "$offenders" ]
}
