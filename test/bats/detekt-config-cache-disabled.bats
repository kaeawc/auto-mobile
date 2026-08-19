#!/usr/bin/env bats
#
# Guards the Detekt job's configuration-cache setting in pull_request.yml (#5332).
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
# This suite pins that setting: flip `reuse-configuration-cache` back to true and
# Fast Validation (BATS Shell Tests -> Shell Tests) goes red instead of the flake
# silently returning.

WF=".github/workflows/pull_request.yml"

# Print the YAML block for a top-level job id (2-space indent), from its header
# up to the next job header.
job_block() {
  awk -v j="$1" '
    $0 ~ "^  " j ":[[:space:]]*$" { cap = 1; next }
    cap && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { exit }
    cap { print }
  ' "$WF"
}

@test "detekt job disables configuration-cache reuse (guards the JVM17 flake)" {
  block="$(job_block detekt)"
  # Guard against a vacuous pass: a renamed/removed job would make job_block
  # return "" and every substring assertion below would trivially fail.
  [[ -n "$block" ]]
  [[ "$block" == *"reuse-configuration-cache: false"* ]]
  [[ "$block" != *"reuse-configuration-cache: true"* ]]
}

@test "detekt job still runs the full detektMain detektTest task list" {
  # Disabling config-cache must not narrow WHAT is analyzed -- the full-tree task
  # list is load-bearing for this project's cross-module potential-bugs rules.
  block="$(job_block detekt)"
  [[ -n "$block" ]]
  [[ "$block" == *"detektMain detektTest"* ]]
}

@test "detekt job keeps the Gradle build cache on (only config-cache is disabled)" {
  # The build cache is what makes the job fast; only configuration-cache reuse is
  # the flake source. `reuse-build-cache` defaults to true, so the job must not
  # opt out of it.
  block="$(job_block detekt)"
  [[ -n "$block" ]]
  [[ "$block" != *"reuse-build-cache: false"* ]]
}
