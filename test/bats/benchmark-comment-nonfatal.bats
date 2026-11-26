#!/usr/bin/env bats
#
# Guards issue #19309: the "Post Consolidated Comment" step in pull_request.yml
# only writes the informational "## MCP Benchmarks" PR comment. A GitHub 5xx on
# that write must not fail Node Checks; "Check Benchmark Results" owns pass/fail.

WORKFLOW=".github/workflows/pull_request.yml"

comment_step() {
  yq -r '.jobs[].steps[]? | select(.name == "Post Consolidated Comment")' "$WORKFLOW"
}

@test "the benchmark comment step is continue-on-error: true" {
  [ "$(yq -r '[.jobs[].steps[]? | select(.name == "Post Consolidated Comment")] | length' "$WORKFLOW")" = "1" ]
  [ "$(comment_step | yq -r '."continue-on-error"')" = "true" ]
}

@test "the benchmark comment write catches its error as a warning" {
  local script
  script="$(comment_step | yq -r '.with.script')"
  [[ "$script" == *"withRetry('createComment'"* ]]
  [[ "$script" == *"withRetry('updateComment'"* ]]
  [[ "$script" == *"core.warning(\`Could not write the MCP Benchmarks comment"* ]]
}

@test "the pass/fail gate still runs after the comment step" {
  [ "$(yq -r '.jobs[].steps[]? | select(.name == "Check Benchmark Results") | .if' "$WORKFLOW")" = '${{ always() && env.TS_CHANGED == '"'"'true'"'"' }}' ]
}
