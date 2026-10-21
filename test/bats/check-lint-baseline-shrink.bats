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

@test "new baseline accepts exactly the issue counts removed from an existing baseline" {
  baseline android/one/lint-baseline.xml Alpha
  baseline android/two/lint-baseline.xml Alpha Beta
  commit_fixture
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *'2 files checked'* ]]
}

@test "new baseline with one extra issue fails and reports net growth" {
  baseline android/one/lint-baseline.xml Alpha
  baseline android/two/lint-baseline.xml Alpha Beta Beta
  commit_fixture
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *'new baseline (3 issues)'* ]]
  [[ "$output" == *'Beta 1 -> 2'* ]]
  [[ "$output" == *'all baselines: total 3 -> 4'* ]]
}

@test "new baseline without matching issue-id shrink fails even when total shrinks" {
  baseline android/one/lint-baseline.xml Alpha
  baseline android/two/lint-baseline.xml Gamma
  commit_fixture
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *'new baseline (1 issues)'* ]]
  [[ "$output" == *'Gamma 0 -> 1'* ]]
}

@test "two new baselines cannot spend the same shrink pool twice" {
  baseline android/one/lint-baseline.xml Alpha Alpha
  baseline android/two/lint-baseline.xml Beta
  mkdir -p android/three
  baseline android/three/lint-baseline.xml Beta
  commit_fixture
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *'android/two/lint-baseline.xml: new baseline (1 issues)'* ]]
  [[ "$output" == *'Beta 0 -> 1'* ]]
}

@test "deleted baselines contribute their issue counts to moves" {
  rm android/one/lint-baseline.xml
  baseline android/two/lint-baseline.xml Alpha Alpha Beta
  commit_fixture
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
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
  printf '<issues><!-- <issue id="New"/> --><issue id="A&#38;B" message="a &amp; b"><location file="x"/></issue></issues>\n' > android/one/lint-baseline.xml
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

located_baseline() {
  printf '<issues><issue id="Alpha" message="same finding" errorLine1="%s"><location file="%s" line="%s" column="%s"/></issue></issues>\n' \
    "${4:-old source}" "$2" "${3:-1}" "${3:-1}" > "$1"
}

@test "same-id replacement at another location fails" {
  located_baseline android/one/lint-baseline.xml Old.kt
  commit_fixture
  git update-ref refs/remotes/origin/main HEAD
  located_baseline android/one/lint-baseline.xml New.kt
  commit_fixture
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *'Alpha'* ]]
}

@test "line column and errorLine changes alone pass" {
  located_baseline android/one/lint-baseline.xml Old.kt
  commit_fixture
  git update-ref refs/remotes/origin/main HEAD
  located_baseline android/one/lint-baseline.xml Old.kt 99 'new source'
  commit_fixture
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
}

@test "new files cannot spend removed identities on a different location or message" {
  located_baseline android/one/lint-baseline.xml Old.kt
  commit_fixture
  git update-ref refs/remotes/origin/main HEAD
  rm android/one/lint-baseline.xml
  located_baseline android/two/lint-baseline.xml New.kt
  commit_fixture
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  located_baseline android/two/lint-baseline.xml Old.kt
  sed -i.bak 's/same finding/different finding/' android/two/lint-baseline.xml
  commit_fixture
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
}

jj_fixture() {
  mkdir -p .jj fake-bin snapshots/base snapshots/head snapshots/worktree
  cp android/one/lint-baseline.xml snapshots/base/baseline.xml
  cp android/one/lint-baseline.xml snapshots/head/baseline.xml
  cp android/one/lint-baseline.xml snapshots/worktree/baseline.xml
  # Preserve the fixture history without allowing Git discovery.
  mv .git git-metadata
  cat > fake-bin/git <<'STUB'
#!/usr/bin/env bash
echo 'Git must not be used in a jj-only workspace' >&2
exit 97
STUB
  cat > fake-bin/jj <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$JJ_CALLS"
case "$*" in
  'workspace root') printf '%s\n' "$JJ_ROOT" ;;
  'log -r main@origin --no-graph -T ') exit 0 ;;
  'log -r fork_point(@- | main@origin) --no-graph -T commit_id') echo base ;;
  'file list -r base'|'file list -r @-'|'file list -r @')
    [[ "${JJ_LIST_FAIL:-}" != true ]] || exit 1
    printf '%s\n' scripts/android/check-lint-baseline-shrink.sh android/one/lint-baseline.xml ;;
  'file show -r base scripts/android/check-lint-baseline-shrink.sh') exit 0 ;;
  'file show -r base android/one/lint-baseline.xml') cat snapshots/base/baseline.xml ;;
  'file show -r @- android/one/lint-baseline.xml') cat snapshots/head/baseline.xml ;;
  *) echo "unexpected jj command: $*" >&2; exit 1 ;;
esac
STUB
  chmod +x fake-bin/git fake-bin/jj
  export PATH="$PWD/fake-bin:$PATH" JJ_ROOT="$PWD" JJ_CALLS="$PWD/jj-calls"
}

@test "jj-only workspace checks committed baselines and worktree identities" {
  jj_fixture
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *'shrink-only'* ]]
  baseline snapshots/head/baseline.xml Gamma
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  baseline android/one/lint-baseline.xml Alpha
  run bash "$SCRIPT" --worktree --base-ref main@origin
  [ "$status" -eq 0 ]
  baseline android/one/lint-baseline.xml Gamma
  run bash "$SCRIPT" --worktree
  [ "$status" -eq 1 ]
  grep -Fx 'file list -r @' "$JJ_CALLS"
  grep -Fx 'file show -r @- android/one/lint-baseline.xml' "$JJ_CALLS"
}

@test "jj file-list failures fail closed" {
  jj_fixture
  run env JJ_LIST_FAIL=true bash "$SCRIPT" --allow-grow
  [ "$status" -eq 2 ]
}
