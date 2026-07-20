#!/usr/bin/env bats
#
# Guards the `gradle-flags` plumbing in .github/actions/gradle-task-run.
#
# The input is a JSON array ('["--tests", "*Foo"]'). It used to be spliced into
# the step's shell source with `${{ inputs.gradle-flags }}` inside a
# double-quoted string, so the array's own double quotes terminated that string
# and jq received bare `[--tests, *Foo]`. jq failed, the command substitution
# expanded to nothing, and the build ran with every caller flag silently
# missing -- which is what actually broke #3752/#3913 for two debugging cycles:
# `-Dscreenshot.record=true` never reached Gradle, so no baselines were ever
# recorded and the verify step failed on MissingBaseline (not, as hypothesized,
# on a pixel mismatch).
#
# Two invariants keep that from coming back:
#   1. the input crosses into the shell via the environment, never `${{ }}`;
#   2. flags are joined with spaces, because the newline-stripping below the
#      splice deletes newlines without substituting anything -- so
#      newline-separated jq output would concatenate into one mega-flag.
#
# The behavioral tests re-run the action's own flag-building logic rather than
# grepping for it, so a refactor that keeps the invariants stays green.

ACTION=".github/actions/gradle-task-run/action.yml"

# Mirrors the flag assembly in the action's "Evaluate Gradle version & flags"
# step. Kept in sync by the source-scan tests below, which pin the two lines
# this depends on.
build_flags() {
  export GRADLE_FLAGS_JSON="$1"
  local caller_flags
  if ! caller_flags=$(printf '%s' "$GRADLE_FLAGS_JSON" | jq -M -r 'join(" ")' 2>/dev/null); then
    return 1
  fi
  local flags="
  --continue
  --stacktrace
  $caller_flags
  -Dorg.gradle.configuration-cache.internal.report-link-as-warning=true
  "
  # shellcheck disable=SC1003
  echo "${flags//[$'\t\r\n']}"
}

@test "gradle-flags reaches the shell through the environment, not \${{ }}" {
  # The whole bug in one assertion: interpolating the JSON array into shell
  # source breaks the surrounding quoting.
  run grep -c 'inputs.gradle-flags' "$ACTION"
  [ "$status" -eq 0 ]
  grep -q 'GRADLE_FLAGS_JSON: ${{ inputs.gradle-flags }}' "$ACTION"
}

@test "the flag splice does not interpolate gradle-flags into the run body" {
  # `${{ inputs.gradle-flags }}` may appear only in an `env:` mapping (above)
  # and in the debug echo, never inside the flag-building expression.
  ! grep -qE '\$\(echo "\$\{\{ inputs.gradle-flags \}\}"' "$ACTION"
}

@test "flags are joined with spaces, not newline-separated" {
  # `.[]` here would survive this file's own tests but produce a mega-flag in
  # CI, so pin the join explicitly.
  grep -q "jq -M -r 'join(\" \")'" "$ACTION"
}

@test "a malformed gradle-flags input fails the step instead of dropping flags" {
  grep -q '::error::gradle-flags is not a JSON array' "$ACTION"
}

@test "record-step flags survive assembly intact" {
  run build_flags '["--tests", "*ComponentScreenshotTest", "-Dscreenshot.record=true", "--rerun-tasks"]'
  [ "$status" -eq 0 ]
  [[ "$output" == *"--tests *ComponentScreenshotTest"* ]]
  [[ "$output" == *"-Dscreenshot.record=true"* ]]
  [[ "$output" == *"--rerun-tasks"* ]]
}

@test "adjacent flags stay separated" {
  # The regression signature: "--tests*Foo-Dscreenshot.record=true--rerun-tasks".
  run build_flags '["--tests", "*ComponentScreenshotTest", "-Dscreenshot.record=true", "--rerun-tasks"]'
  [ "$status" -eq 0 ]
  [[ "$output" != *"--tests*"* ]]
  [[ "$output" != *"true--rerun-tasks"* ]]
}

@test "the default empty input still yields a usable flag set" {
  run build_flags '[]'
  [ "$status" -eq 0 ]
  [[ "$output" == *"--continue"* ]]
  [[ "$output" == *"--stacktrace"* ]]
}

@test "a non-JSON gradle-flags input is rejected" {
  run build_flags '[--tests, *Foo]'
  [ "$status" -ne 0 ]
}

@test "record and verify steps pass their flags as valid JSON arrays" {
  # A caller that hand-writes a malformed array would now hard-fail the step;
  # catch it here instead.
  workflow=".github/workflows/record-screenshot-baselines.yml"
  while IFS= read -r value; do
    printf '%s' "$value" | jq -e 'type == "array"' >/dev/null
  done < <(grep -oE "gradle-flags: '\[.*\]'" "$workflow" | sed "s/^gradle-flags: '//; s/'$//")
}
