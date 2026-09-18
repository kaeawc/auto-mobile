#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/delete_androidTest.sh"
  TEST_DIR="$(mktemp -d)"
  REPO="$TEST_DIR/repo"
  mkdir -p "$REPO/module"
  printf 'plugin("com.android.application")\n' > "$REPO/settings.gradle"
  printf '// build.gradle\n' > "$REPO/module/build.gradle"
}

teardown() {
  cd /
  rm -rf "$TEST_DIR"
}

@test "execute removes a large set of androidTest directories" {
  for i in $(seq -w 1 350); do
    path="$REPO/module/segment-${i}-with-a-sufficiently-long-name-for-pipe-testing/src/androidTest"
    mkdir -p "$path"
    printf 'placeholder\n' > "$path/placeholder-${i}.txt"
  done

  cd "$REPO"
  run bash "$SCRIPT" --execute

  [ "$status" -eq 0 ]
  [ "$(find "$REPO/module" -path "*/src/androidTest" -type d | wc -l)" -eq 0 ]
  [ "$(find "$REPO/module" -name 'placeholder-*.txt' | wc -l)" -eq 0 ]
  [[ "$output" == *"Removed androidTest from"* ]]
}
