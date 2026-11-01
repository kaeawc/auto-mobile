#!/usr/bin/env bats
setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  HELPER="$REPO_ROOT/scripts/lib/spotlight-exclude.sh"
  export AUTOMOBILE_SPOTLIGHT_EXCLUDE_FORCE=1
  unset AUTOMOBILE_SPOTLIGHT_EXCLUDE
  DIR="$BATS_TEST_TMPDIR/output space"
  mkdir -p "$DIR"
}

@test "forced Darwin creates a marker quietly and is idempotent" {
  run bash -c 'source "$1"; spotlight_exclude_dir "$2"; spotlight_exclude_dir "$2"' _ "$HELPER" "$DIR"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ -f "$DIR/.metadata_never_index" ]
}

@test "non-Darwin ignores directories" {
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  printf '#!/bin/bash\necho Linux\n' > "$BATS_TEST_TMPDIR/bin/uname"
  chmod +x "$BATS_TEST_TMPDIR/bin/uname"
  run env AUTOMOBILE_SPOTLIGHT_EXCLUDE_FORCE=0 PATH="$BATS_TEST_TMPDIR/bin:$PATH" bash -c 'source "$1"; spotlight_exclude_dir "$2"' _ "$HELPER" "$DIR"
  [ "$status" -eq 0 ]
  [ ! -e "$DIR/.metadata_never_index" ]
}

@test "missing directories are ignored" {
  run bash -c 'source "$1"; spotlight_exclude_dir "$2/missing"' _ "$HELPER" "$DIR"
  [ "$status" -eq 0 ]
  [ ! -e "$DIR/missing" ]
}

@test "opt-out wins over forced Darwin" {
  run env AUTOMOBILE_SPOTLIGHT_EXCLUDE=0 bash -c 'source "$1"; spotlight_exclude_dir "$2"' _ "$HELPER" "$DIR"
  [ "$status" -eq 0 ]
  [ ! -e "$DIR/.metadata_never_index" ]
}

@test "mkdir wrapper creates nested directories and markers" {
  run bash -c 'source "$1"; mkdir_spotlight_excluded "$2/nested/output" "$2/other"' _ "$HELPER" "$DIR"
  [ "$status" -eq 0 ]
  [ -f "$DIR/nested/output/.metadata_never_index" ]
  [ -f "$DIR/other/.metadata_never_index" ]
}

@test "sourcing has no side effects" {
  run bash -c 'touch() { exit 9; }; uname() { exit 8; }; mkdir() { exit 7; }; source "$1"' _ "$HELPER"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "read-only marker failure is quiet and survives errexit" {
  # Fake a read-only filesystem reliably even for privileged test runners.
  run bash -c 'set -euo pipefail; source "$1"; touch() { echo denied >&2; return 1; }; spotlight_exclude_dir "$2"; echo survived' _ "$HELPER" "$DIR"
  [ "$status" -eq 0 ]
  [ "$output" = survived ]
}

@test "generated-directory entrypoints source the shared helper" {
  while IFS= read -r script; do
    grep -F "spotlight-exclude.sh" "$REPO_ROOT/scripts/$script" > /dev/null || {
      echo "Missing Spotlight helper source: $script"
      return 1
    }
  done <<'SCRIPTS'
prepush-node.sh
test-ts.sh
all_fast_validate_checks.sh
avd_experiments.sh
prepush-integration-safe.sh
launch_app_perf_test.sh
ci/pr-failing-job-logs.sh
codex/bootstrap-worktree.sh
ios/userdefaults-no-sdk-smoke.sh
local-dev/hot-reload.sh
android/gradlew_task.sh
ios/sign-ios-frameworks.sh
ios/ctrl-proxy-build-for-testing.sh
ios/xcode-build.sh
ios/xcode-test.sh
ios/ctrl-proxy-run.sh
test-ctrl-proxy-ios.sh
local-dev/lib/ctrl-proxy-ios.sh
prepush-ios.sh
ios/protoviewer-build.sh
ios/prototype-viewer-build.sh
ios/prototype-library-build.sh
ios/prototype-agent-build.sh
ios/build-prototype-agent.sh
ios/build-prototype-viewer-release.sh
ios/build-screen-capture-helper-release.sh
ios/build-audio-loopback-helper-release.sh
ios/build-network-filter-probe.sh
lib/host-slots.sh
lib/bun-unit-chunks.sh
SCRIPTS
}

@test "mkdir wrapper preserves directory creation errors even in a conditional caller" {
  run bash -c 'source "$1"; mkdir() { return 23; }; if mkdir_spotlight_excluded "$2"; then exit 99; else exit $?; fi' _ "$HELPER" "$DIR"
  [ "$status" -eq 23 ]
}

@test "bounded mkdir marks a descendant inside the root" {
  run bash -c 'source "$1"; mkdir_spotlight_excluded_within "$2" "$2/nested/output"' _ "$HELPER" "$DIR"
  [ "$status" -eq 0 ]
  [ -f "$DIR/nested/output/.metadata_never_index" ]
}

@test "bounded mkdir marks the root itself" {
  run bash -c 'source "$1"; mkdir_spotlight_excluded_within "$2" "$2"' _ "$HELPER" "$DIR"
  [ "$status" -eq 0 ]
  [ -f "$DIR/.metadata_never_index" ]
}

@test "bounded mkdir creates outside output without marking it" {
  run bash -c 'source "$1"; mkdir_spotlight_excluded_within "$2" "$2-sibling/output"' _ "$HELPER" "$DIR"
  [ "$status" -eq 0 ]
  [ -d "$DIR-sibling/output" ]
  [ ! -e "$DIR-sibling/output/.metadata_never_index" ]
}

@test "bounded mkdir never marks an ancestor of the root" {
  run bash -c 'source "$1"; mkdir_spotlight_excluded_within "$2" "$2/.."' _ "$HELPER" "$DIR"
  [ "$status" -eq 0 ]
  [ ! -e "$DIR/../.metadata_never_index" ]
}

@test "bounded mkdir resolves symlink escapes before marking" {
  mkdir -p "$BATS_TEST_TMPDIR/outside"
  ln -s "$BATS_TEST_TMPDIR/outside" "$DIR/escape"
  run bash -c 'source "$1"; mkdir_spotlight_excluded_within "$2" "$2/escape/output"' _ "$HELPER" "$DIR"
  [ "$status" -eq 0 ]
  [ -d "$BATS_TEST_TMPDIR/outside/output" ]
  [ ! -e "$BATS_TEST_TMPDIR/outside/output/.metadata_never_index" ]
}

@test "bounded mkdir resolves a symlinked root and relative output" {
  ln -s "$DIR" "$BATS_TEST_TMPDIR/root-link"
  run bash -c 'source "$1"; cd "$2"; mkdir_spotlight_excluded_within "$3" ./nested' _ "$HELPER" "$DIR" "$BATS_TEST_TMPDIR/root-link"
  [ "$status" -eq 0 ]
  [ -f "$DIR/nested/.metadata_never_index" ]
}

@test "bounded mkdir preserves creation errors in conditional callers" {
  run bash -c 'source "$1"; mkdir() { return 23; }; if mkdir_spotlight_excluded_within "$2" "$2/nested"; then exit 99; else exit $?; fi' _ "$HELPER" "$DIR"
  [ "$status" -eq 23 ]
}

@test "caller-selected output paths use the repository-bounded marker" {
  # Each entry: script | exact bounded invocation required for the caller-supplied path (#15070).
  while IFS='|' read -r script expected; do
    grep -F -- "$expected" "$REPO_ROOT/scripts/$script" > /dev/null || {
      echo "Missing bounded Spotlight marker in $script: $expected"
      return 1
    }
  done <<'SITES'
ios/xcode-build.sh|mkdir_spotlight_excluded_within "${PROJECT_ROOT}" "${AUTOMOBILE_XCODE_DERIVED_DATA}"
ios/xcode-test.sh|mkdir_spotlight_excluded_within "${PROJECT_ROOT}" "${AUTOMOBILE_XCODE_DERIVED_DATA}"
ios/ctrl-proxy-build-for-testing.sh|mkdir_spotlight_excluded_within "${PROJECT_ROOT}" "${DERIVED_DATA}"
prepush-ios.sh|mkdir_spotlight_excluded_within "${project_root}" "${AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA:-
lib/bun-unit-chunks.sh|mkdir_spotlight_excluded_within "$root" "$coverage_root"
test-ts.sh|mkdir_spotlight_excluded_within "$ROOT" "${AUTOMOBILE_TEST_TS_SCRATCH_DIR:-$ROOT/scratch}"
test-ts.sh|mkdir_spotlight_excluded_within "$ROOT" "$coverage_root"
test-ts.sh|mkdir_spotlight_excluded_within "$ROOT" "$shard_root"
SITES
}

@test "unbounded marker never receives a caller-supplied override" {
  run grep -En 'mkdir_spotlight_excluded .*(AUTOMOBILE_[A-Z_]*(DIR|ROOT|DATA|PATH)|\$coverage_root|\$shard_root)' \
    "$REPO_ROOT/scripts/ios/xcode-build.sh" "$REPO_ROOT/scripts/ios/xcode-test.sh" \
    "$REPO_ROOT/scripts/ios/ctrl-proxy-build-for-testing.sh" "$REPO_ROOT/scripts/prepush-ios.sh" \
    "$REPO_ROOT/scripts/lib/bun-unit-chunks.sh" "$REPO_ROOT/scripts/test-ts.sh"
  [ "$status" -eq 1 ]
  [ -z "$output" ]
}

@test "the fixed /tmp ctrl-proxy default stays on the unconditional marker" {
  run grep -F 'mkdir_spotlight_excluded "${DERIVED_DATA}"' "$REPO_ROOT/scripts/ios/ctrl-proxy-build-for-testing.sh"
  [ "$status" -eq 0 ]
  run grep -F 'mkdir_spotlight_excluded "${DEFAULT_DERIVED_DATA}"' "$REPO_ROOT/scripts/ios/ctrl-proxy-build-for-testing.sh"
  [ "$status" -eq 0 ]
}
