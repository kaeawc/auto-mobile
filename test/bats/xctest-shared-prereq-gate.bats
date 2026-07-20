#!/usr/bin/env bats
#
# Guards issue #4082: the Xcode 26.5 leg of `ios-xctest-runner-simulator-tests`
# uses `if: !cancelled()` so it runs even when the *26.2* leg's tests failed
# (deliberate leg-independence). But a bare `!cancelled()` also bypasses a
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

@test "the 26.5 leg gates on steps.build-ctrlproxy.outcome == success" {
  # The eight 26.5-leg steps that were !cancelled() now carry the shared-build guard.
  count="$(grep -c "!cancelled() && steps.build-ctrlproxy.outcome == 'success'" "$WORKFLOW")"
  [ "$count" -ge 8 ]
}
