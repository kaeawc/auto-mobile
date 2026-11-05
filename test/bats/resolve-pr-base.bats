#!/usr/bin/env bats
#
# scripts/ci/resolve-pr-base.sh resolves the commit a PR's changed-file checks
# diff against (#16972). A stacked PR's base branch can be missing from the
# clone or deleted on the remote; the base commit must still resolve.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/ci/resolve-pr-base.sh"
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  export GIT_AUTHOR_NAME=test GIT_COMMITTER_NAME=test
  export GIT_AUTHOR_EMAIL=test@example.com GIT_COMMITTER_EMAIL=test@example.com
  export GIT_CONFIG_COUNT=2
  export GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false
  # GitHub serves any reachable commit by SHA; a local bare remote needs this.
  export GIT_CONFIG_KEY_1=uploadpack.allowAnySHA1InWant GIT_CONFIG_VALUE_1=true

  remote="$BATS_TEST_TMPDIR/remote.git"
  upstream="$BATS_TEST_TMPDIR/upstream"
  clone="$BATS_TEST_TMPDIR/clone"
  git init -q --bare "$remote"
  git init -q -b main "$upstream"
  cd "$upstream"
  echo base > file
  git add file
  git commit -qm main
  git remote add origin "$remote"
  git push -q origin main
  # The PR below this one in a stack: its own branch, one commit past main.
  git checkout -q -b work/below
  echo below > below-only
  git add below-only
  git commit -qm below
  git push -q origin work/below
  stacked_base="$(git rev-parse HEAD)"
  git clone -q --single-branch --branch main "$remote" "$clone"
  cd "$clone"
}

@test "prints a base commit already in the clone without fetching" {
  main_sha="$(git rev-parse HEAD)"
  run bash "$SCRIPT" "$main_sha"
  [ "$status" -eq 0 ]
  [ "$output" = "$main_sha" ]
}

@test "fetches a stacked PR's base commit that the clone does not have" {
  ! git rev-parse --verify --quiet "${stacked_base}^{commit}"
  run bash "$SCRIPT" "$stacked_base"
  [ "$status" -eq 0 ]
  [ "$output" = "$stacked_base" ]
  # stdout is the SHA alone, so callers can pass it straight to --base.
  [ "${#lines[@]}" -eq 1 ]
}

@test "resolves the base commit after the stacked base branch is deleted" {
  # The PR below merges and its branch is auto-deleted; the commit stays
  # reachable from main.
  git -C "$upstream" checkout -q main
  git -C "$upstream" merge -q --ff-only work/below
  git -C "$upstream" push -q origin main
  git -C "$upstream" push -q origin --delete work/below
  run bash "$SCRIPT" "$stacked_base"
  [ "$status" -eq 0 ]
  [ "$output" = "$stacked_base" ]
}

@test "the resolved base gives prepush-shell.sh-style diffs only the PR's own changes" {
  base="$(bash "$SCRIPT" "$stacked_base")"
  git fetch -q origin work/below
  git checkout -q --detach FETCH_HEAD
  echo pr >> file
  echo new > pr-only
  git add -A
  git commit -qm pr
  run git diff --name-only "${base}...HEAD"
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'file\npr-only')" ]
}

@test "fails with a clear message when the commit is not on the remote" {
  run bash "$SCRIPT" 0123456789abcdef0123456789abcdef01234567
  [ "$status" -eq 1 ]
  [[ "$output" == *"PR base commit 0123456789abcdef0123456789abcdef01234567 is not in this clone and could not be fetched from 'origin'."* ]]
}

@test "rejects a branch name or short SHA" {
  run bash "$SCRIPT" "origin/work/below"
  [ "$status" -eq 2 ]
  [[ "$output" == *"not a full 40-character commit SHA"* ]]
  run bash "$SCRIPT" "${stacked_base:0:12}"
  [ "$status" -eq 2 ]
}

@test "requires exactly one argument" {
  run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"Usage: resolve-pr-base.sh <base-sha>"* ]]
}
