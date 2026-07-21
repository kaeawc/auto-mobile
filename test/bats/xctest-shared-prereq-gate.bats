#!/usr/bin/env bats
#
# Guards issue #4082: the Xcode 26.5 leg of `ios-xctest-runner-simulator-tests`
# uses `if: !cancelled()` so it runs even when an earlier step in the job failed
# (deliberate independence from the CtrlProxy UI test that precedes it; before
# #4078 this also covered the now-removed Xcode 26.2 Reminders leg). But a bare
# `!cancelled()` also bypasses a
# SHARED-prerequisite failure (XcodeGen drift check / CtrlProxy build), so the
# 26.5 block ran on a broken build and emitted misleading secondary failures
# (e.g. a spurious "Run Reminders integration tests (Xcode 26.5)" failure whose
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
# Scanning starts only AFTER the step that immediately precedes the 26.5 leg:
# several step names occur twice in the job (e.g. "Select Xcode 26.5" is both the
# job's initial toolchain selection, which has no `if:`, and the 26.5 leg's
# re-selection, which does). Without the anchor the first, unguarded occurrence
# matches and the assertion reports a false violation. This mirrors
# `afterStepName` in the Swift helper.
#
# The anchor was "Run Reminders integration tests (Xcode 26.2)" until #4078 dropped
# the 26.2 leg from PRs. "Shutdown iOS Simulators" replaces it: it is the unique
# `if: always()` teardown that still sits directly above the 26.5 leg. If it ever
# stops being unique or moves, the step-lookup below fails loudly (no `if:` found)
# rather than silently matching the wrong occurrence.
#
# awk, not sed -- BSD sed lacks the range forms this needs. A step block runs from
# its `- name: "<step>"` line to the next step start or a step-indent comment.
ANCHOR_STEP='Shutdown iOS Simulators'

step_if_condition() {
  awk -v want="      - name: \"$1\"" -v anchor="      - name: \"$ANCHOR_STEP\"" '
    !past && $0 == anchor { past = 1; next }
    !past { next }
    $0 == want { inblock = 1; next }
    inblock && /^      [-#]/ { exit }
    inblock && /^        if:/ {
      sub(/^        if:[[:space:]]*/, "")
      print
      exit
    }
  ' "$WORKFLOW"
}

# Every Xcode 26.5 leg step that must not run on a doomed shared prerequisite.
# Named explicitly: a global count cannot tell "each of these is guarded" from
# "the total happens to add up", so one step could lose its guard while an
# unrelated step gained one and the suite would stay green.
xcode_265_leg_steps() {
  cat <<'STEPS'
Boot iOS Simulator (Xcode 26.5)
Ensure AutoMobile daemon ready (Xcode 26.5)
Warm up iOS CtrlProxy (Xcode 26.5)
Pre-build Reminders XCTest bundle (Xcode 26.5)
Warm up Reminders target app (Xcode 26.5)
Run Reminders integration tests (Xcode 26.5)
STEPS
}

@test "the extraction anchor step exists exactly once" {
  # Everything below scans from this anchor. A missing anchor makes every lookup
  # return nothing (which fails loudly), but a DUPLICATED anchor would silently
  # shift the scan window and could re-admit the wrong occurrence of a step name.
  count="$(grep -c "^      - name: \"$ANCHOR_STEP\"\$" "$WORKFLOW" || true)"
  [ "$count" -eq 1 ]
}

@test "every 26.5-leg step individually gates on steps.build-ctrlproxy.outcome == success" {
  local offenders=""
  while IFS= read -r step; do
    [ -n "$step" ] || continue
    condition="$(step_if_condition "$step")"
    if [ -z "$condition" ]; then
      offenders="${offenders}${step}: no 'if:' condition"$'\n'
    elif [[ "$condition" != *"steps.build-ctrlproxy.outcome == 'success'"* ]]; then
      offenders="${offenders}${step}: ${condition}"$'\n'
    fi
  done < <(xcode_265_leg_steps)

  if [ -n "$offenders" ]; then
    echo "26.5-leg steps missing the shared-build guard:" >&2
    echo "$offenders" >&2
  fi
  [ -z "$offenders" ]
}

@test "every 26.5-leg step still respects cancellation" {
  # The other half of the condition. RemindersPlanContentTests owns this too (via
  # stepBlockRespectsCancellation); asserted here so a Swift-only or bats-only run
  # cannot lose the property silently.
  local offenders=""
  while IFS= read -r step; do
    [ -n "$step" ] || continue
    condition="$(step_if_condition "$step")"
    if [[ "$condition" != *"!cancelled()"* ]] || [[ "$condition" == *"||"* ]]; then
      offenders="${offenders}${step}: ${condition:-<none>}"$'\n'
    fi
  done < <(xcode_265_leg_steps)

  if [ -n "$offenders" ]; then
    echo "26.5-leg steps that do not skip on cancellation:" >&2
    echo "$offenders" >&2
  fi
  [ -z "$offenders" ]
}
