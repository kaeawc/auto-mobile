#!/usr/bin/env bats
# bats file_tags=parallel-within-file

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  repo_dir="$BATS_TEST_TMPDIR/repo"
  goldens="android/control-proxy/src/test/resources/screenshots/prototype"
  budgets="test/fixtures/prototype-web/android-parity-budgets.json"
  mkdir -p "$repo_dir/scripts/lib" "$repo_dir/scripts/prototype" "$repo_dir/$goldens" "$repo_dir/test/fixtures/prototype-web"
  cp "$REPO_ROOT/scripts/lib/vcs-diff.sh" "$repo_dir/scripts/lib/"
  cp "$REPO_ROOT/scripts/prototype/check-android-parity-budgets.sh" \
    "$REPO_ROOT/scripts/prototype/check-android-parity-budgets.ts" "$repo_dir/scripts/prototype/"
  cd "$repo_dir"
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  export GIT_AUTHOR_NAME=test GIT_COMMITTER_NAME=test
  export GIT_AUTHOR_EMAIL=test@example.com GIT_COMMITTER_EMAIL=test@example.com
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false
  unset GITHUB_ACTIONS GITHUB_BASE_REF
  : > "$goldens/alpha.png"
  : > "$goldens/beta.png"
  printf '{"alpha": 100, "beta": 50}\n' > "$budgets"
  git init -q
  git add .
  git commit -qm initial
  git update-ref refs/remotes/origin/main HEAD
}

commit_fixture() {
  git add -A
  git commit -qm "${1:-change}"
}

@test "lowering a budget passes" {
  printf '{"alpha": 90, "beta": 50}\n' > "$budgets"
  commit_fixture
  run bash scripts/prototype/check-android-parity-budgets.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *'shrink-only (2 checked)'* ]]
}

@test "raising a budget fails with the golden name and both values" {
  printf '{"alpha": 101, "beta": 50}\n' > "$budgets"
  commit_fixture
  run bash scripts/prototype/check-android-parity-budgets.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *'alpha: budget raised 100 -> 101'* ]]
}

@test "an uncommitted raise fails too" {
  printf '{"alpha": 100, "beta": 51}\n' > "$budgets"
  run bash scripts/prototype/check-android-parity-budgets.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *'beta: budget raised 50 -> 51'* ]]
}

@test "adding a budget for a new golden passes" {
  : > "$goldens/gamma.png"
  printf '{"alpha": 100, "beta": 50, "gamma": 7}\n' > "$budgets"
  commit_fixture
  run bash scripts/prototype/check-android-parity-budgets.sh
  [ "$status" -eq 0 ]
}

@test "removing a budget passes" {
  printf '{"alpha": 100}\n' > "$budgets"
  commit_fixture
  run bash scripts/prototype/check-android-parity-budgets.sh
  [ "$status" -eq 0 ]
}

@test "a Parity-Budget-Grow trailer allows the golden it names" {
  printf '{"alpha": 200, "beta": 50}\n' > "$budgets"
  commit_fixture "$(printf 'raise alpha\n\nParity-Budget-Grow: alpha')"
  run bash scripts/prototype/check-android-parity-budgets.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *'allowed by trailer: alpha: budget raised 100 -> 200'* ]]
}

@test "a budgets file new on the branch is accepted" {
  git rm -q "$budgets"
  git commit -qm drop
  git update-ref refs/remotes/origin/main HEAD
  mkdir -p "$(dirname "$budgets")"
  printf '{"alpha": 9999}\n' > "$budgets"
  commit_fixture
  run bash scripts/prototype/check-android-parity-budgets.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *'initial budgets accepted'* ]]
}

@test "a missing base ref fails closed" {
  run bash scripts/prototype/check-android-parity-budgets.sh --base-ref origin/nope
  [ "$status" -eq 2 ]
  [[ "$output" == *'missing base origin/nope'* ]]
}
