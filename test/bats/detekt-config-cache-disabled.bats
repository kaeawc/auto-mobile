#!/usr/bin/env bats
#
# Guards the Detekt job's configuration-cache setting in both the PR-CI
# (pull_request.yml) and post-merge backstop (merge.yml) workflows (#5332).
#
# The Detekt job (`detektMain detektTest` via `.github/actions/gradle-task-run`)
# intermittently failed ~2min with a generic exit 1 and NO `.kt` annotations:
#
#   Dependency requires at least JVM runtime version 21. This build uses a Java 17 JVM.
#
# even though the action pins Zulu JDK 21 and a local `--rerun-tasks` run is green.
# That is a configuration-cache-REUSE corruption flake -- a restored cache entry
# evaluates the Metro Gradle plugin classpath under a stale JVM context. Disabling
# configuration-cache reuse for this job removes the flake deterministically; the
# Gradle BUILD cache (the actual speed win) stays on, so the cost is only the
# configuration phase, not a full recompile.
#
# Both the PR job AND the merge.yml full-tree backstop run the identical task list
# and were both subject to the flake, so both must disable reuse -- otherwise the
# flake just moves to reddening main post-merge. This suite pins both: flip either
# `reuse-configuration-cache` back to true and Fast Validation (BATS Shell Tests
# -> Shell Tests) goes red instead of the flake silently returning.

# Print the YAML block for a top-level job id (2-space indent) in $1, from its
# header up to the next job header.
job_block() {
  awk -v j="$2" '
    $0 ~ "^  " j ":[[:space:]]*$" { cap = 1; next }
    cap && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { exit }
    cap { print }
  ' "$1"
}

@test "PR-CI detekt job disables configuration-cache reuse (guards the JVM17 flake)" {
  block="$(job_block ".github/workflows/pull_request.yml" detekt)"
  # Guard against a vacuous pass: a renamed/removed job would make job_block
  # return "" and every substring assertion below would trivially fail.
  [[ -n "$block" ]]
  [[ "$block" == *"reuse-configuration-cache: false"* ]]
  [[ "$block" != *"reuse-configuration-cache: true"* ]]
}

@test "merge.yml post-merge detekt backstop also disables configuration-cache reuse" {
  block="$(job_block ".github/workflows/merge.yml" detekt)"
  [[ -n "$block" ]]
  [[ "$block" == *"reuse-configuration-cache: false"* ]]
  [[ "$block" != *"reuse-configuration-cache: true"* ]]
}

@test "both detekt jobs still run the full detektMain detektTest task list" {
  # Disabling config-cache must not narrow WHAT is analyzed -- the full-tree task
  # list is load-bearing for this project's cross-module potential-bugs rules.
  for wf in ".github/workflows/pull_request.yml" ".github/workflows/merge.yml"; do
    block="$(job_block "$wf" detekt)"
    [[ -n "$block" ]]
    [[ "$block" == *"detektMain detektTest"* ]]
  done
}

@test "both detekt jobs keep the Gradle build cache on (only config-cache is disabled)" {
  # The build cache is what makes the job fast; only configuration-cache reuse is
  # the flake source. `reuse-build-cache` defaults to true, so neither job must
  # opt out of it.
  for wf in ".github/workflows/pull_request.yml" ".github/workflows/merge.yml"; do
    block="$(job_block "$wf" detekt)"
    [[ -n "$block" ]]
    [[ "$block" != *"reuse-build-cache: false"* ]]
  done
}
