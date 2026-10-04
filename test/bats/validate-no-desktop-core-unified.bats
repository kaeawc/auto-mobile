#!/usr/bin/env bats
#
# Tests for scripts/android/validate-no-desktop-core-unified.sh

setup() {
  SCRIPT="$(cd "$BATS_TEST_DIRNAME/../../scripts/android" && pwd)/validate-no-desktop-core-unified.sh"
  ROOT="$BATS_TEST_TMPDIR/root"
  FIXTURE_DIR="$ROOT/android/desktop-core/src/test/kotlin/dev/jasonpearson/automobile/desktop"
  mkdir -p "$FIXTURE_DIR" "$BATS_TEST_TMPDIR/home" "$BATS_TEST_TMPDIR/git-template"
  printf 'package dev.jasonpearson.automobile.desktop\n' > "$FIXTURE_DIR/Fixture.kt"

  # Ignore caller Git state, host configuration, and parent repositories.
  unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY
  unset GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS
  unset RIPGREP_CONFIG_PATH
  export HOME="$BATS_TEST_TMPDIR/home"
  export XDG_CONFIG_HOME="$HOME/.config"
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1
  export GIT_CEILING_DIRECTORIES="$BATS_TEST_TMPDIR"
}

init_fixture_git_repo() {
  if ! PATH=/usr/bin:/bin command -v git > /dev/null 2>&1; then
    skip "git is unavailable on /usr/bin:/bin"
  fi
  PATH=/usr/bin:/bin git -c init.templateDir="$BATS_TEST_TMPDIR/git-template" -C "$ROOT" init -q
}

@test "passes when the desktop-core unified socket-client package is absent" {
  run bash "$SCRIPT" "$ROOT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"No desktop-core unified socket-client package or references found."* ]]
}

@test "passes when invoked outside the repo root" {
  mkdir -p "$BATS_TEST_TMPDIR/outside"
  cd "$BATS_TEST_TMPDIR/outside"
  run bash "$SCRIPT" "$ROOT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"No desktop-core unified socket-client package or references found."* ]]
}

@test "fails when a core.unified package reference is present" {
  printf 'package dev.jasonpearson.automobile.desktop\nimport dev.jasonpearson.automobile.desktop.core.unified.UnifiedSocketClient\n' \
    > "$FIXTURE_DIR/__UnifiedReferenceGuardFixture.kt"
  run bash "$SCRIPT" "$ROOT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"desktop-core still references the deleted core.unified package"* ]]
}

@test "passes without ripgrep on PATH (git-grep fallback)" {
  # Regression for #5386: a PATH without rg must use git grep in a worktree.
  init_fixture_git_repo
  run env PATH="/usr/bin:/bin" bash "$SCRIPT" "$ROOT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"No desktop-core unified socket-client package or references found."* ]]
}

@test "detects references without ripgrep in a git root (git-grep fallback)" {
  init_fixture_git_repo
  printf 'import dev.jasonpearson.automobile.desktop.core.unified.UnifiedSocketClient\n' \
    > "$FIXTURE_DIR/__UnifiedReferenceGuardFixture.kt"
  run env PATH="/usr/bin:/bin" bash "$SCRIPT" "$ROOT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"desktop-core still references the deleted core.unified package"* ]]
}

@test "detects references without ripgrep in a non-git root (grep fallback)" {
  # jj workspaces and hosts without rg still need the plain-grep last resort.
  printf 'import dev.jasonpearson.automobile.desktop.core.unified.UnifiedSocketClient\n' \
    > "$FIXTURE_DIR/__UnifiedReferenceGuardFixture.kt"
  run env PATH="/usr/bin:/bin" bash "$SCRIPT" "$ROOT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"desktop-core still references the deleted core.unified package"* ]]
}

@test "fails when the unified package directory itself is present" {
  mkdir -p "$ROOT/android/desktop-core/src/main/kotlin/dev/jasonpearson/automobile/desktop/core/unified"
  run bash "$SCRIPT" "$ROOT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"unified socket-client package still exists"* ]]
}
