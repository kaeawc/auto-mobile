#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/android/check-lint-baseline-shrink.sh"
  fixture_repo="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$fixture_repo/android/one" "$fixture_repo/android/two"
  cd "$fixture_repo"
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  export GIT_AUTHOR_NAME=test GIT_COMMITTER_NAME=test
  export GIT_AUTHOR_EMAIL=test@example.com GIT_COMMITTER_EMAIL=test@example.com
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false
  git init -q
  baseline android/one/lint-baseline.xml Alpha Alpha Beta
  # The guard is strict only once it exists at the merge-base (see the bootstrap test).
  mkdir -p scripts/android
  : > scripts/android/check-lint-baseline-shrink.sh
  git add .
  git commit -qm initial
  git update-ref refs/remotes/origin/main HEAD
}

baseline() {
  local path="$1"
  shift
  printf '<issues>\n' > "$path"
  for id in "$@"; do
    printf '<issue\n id="%s" message="a &amp; b"><location file="x"/></issue>\n' "$id" >> "$path"
  done
  printf '</issues>\n' >> "$path"
}

commit_fixture() {
  git add -A
  git commit -qm change
}

@test "unchanged baselines pass" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *'1 files checked'* ]]
}

@test "shrinking and deleting baselines pass" {
  baseline android/one/lint-baseline.xml Alpha
  commit_fixture
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  rm android/one/lint-baseline.xml
  commit_fixture
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
}

@test "total and issue-id growth fail" {
  baseline android/one/lint-baseline.xml Alpha Alpha Alpha Beta
  commit_fixture
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *'total 3 -> 4'* ]]
  [[ "$output" == *'Alpha 2 -> 3'* ]]
}

@test "a falling total cannot hide growth of another id" {
  baseline android/one/lint-baseline.xml Gamma
  commit_fixture
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *'Gamma 0 -> 1'* ]]
}

@test "counts cannot move between modules" {
  baseline android/two/lint-baseline.xml Beta
  git add .
  git commit -qm 'second module'
  git update-ref refs/remotes/origin/main HEAD
  baseline android/one/lint-baseline.xml Alpha
  baseline android/two/lint-baseline.xml Beta Alpha
  commit_fixture
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *'android/two/lint-baseline.xml: Alpha 0 -> 1'* ]]
}

@test "new baselines fail even when empty; allow-grow is explicit" {
  baseline android/two/lint-baseline.xml
  commit_fixture
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *'new baseline (0 issues)'* ]]
  run bash "$SCRIPT" --allow-grow
  [ "$status" -eq 0 ]
  [[ "$output" == *'explicitly allowed'* ]]
}

@test "HEAD ignores local edits but worktree mode catches untracked and staged growth" {
  baseline android/two/lint-baseline.xml Gamma
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  run bash "$SCRIPT" --worktree
  [ "$status" -eq 1 ]
  [[ "$output" == *'new baseline'* ]]
  git add android/two/lint-baseline.xml
  run bash "$SCRIPT" --worktree
  [ "$status" -eq 1 ]
}

@test "worktree mode catches unstaged edits and allows deletions" {
  baseline android/one/lint-baseline.xml Alpha Alpha Beta Gamma
  run bash "$SCRIPT" --worktree
  [ "$status" -eq 1 ]
  rm android/one/lint-baseline.xml
  run bash "$SCRIPT" --worktree
  [ "$status" -eq 0 ]
}

@test "uses the merge-base rather than the tip of a diverged main" {
  base="$(git rev-parse HEAD)"
  baseline android/one/lint-baseline.xml Alpha
  commit_fixture
  git update-ref refs/remotes/origin/main HEAD
  git checkout -q --detach "$base"
  baseline android/one/lint-baseline.xml Alpha Beta
  commit_fixture
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
}

@test "XML comments are not issues and entities are decoded" {
  baseline android/one/lint-baseline.xml 'A&amp;B'
  commit_fixture
  git update-ref refs/remotes/origin/main HEAD
  printf '<issues><!-- <issue id="New"/> --><issue id="A&#38;B"/></issues>\n' > android/one/lint-baseline.xml
  commit_fixture
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
}

@test "malformed XML and missing comparison refs fail closed even with allow-grow" {
  printf '<issues><issue' > android/one/lint-baseline.xml
  commit_fixture
  run bash "$SCRIPT" --allow-grow
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" --base-ref missing
  [ "$status" -ne 0 ]
}

@test "invalid arguments fail and help succeeds" {
  run bash "$SCRIPT" --unknown
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" --base-ref
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" --help
  [ "$status" -eq 0 ]
}

@test "the change that introduces the guard may add initial baselines" {
  git rm -q scripts/android/check-lint-baseline-shrink.sh
  git commit -qm "drop guard"
  git update-ref refs/remotes/origin/main HEAD
  baseline android/two/lint-baseline.xml Alpha Beta
  commit_fixture
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *'initial baselines accepted'* ]]
}
