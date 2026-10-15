#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  TEST_ROOT="$(mktemp -d)"
  mkdir -p "$TEST_ROOT/scripts/lib" "$TEST_ROOT/scripts/ci" "$TEST_ROOT/bin"
  cp "$REPO_ROOT/scripts/prepush.sh" "$TEST_ROOT/scripts/prepush.sh"
  cp "$REPO_ROOT/scripts/lib/vcs-diff.sh" "$TEST_ROOT/scripts/lib/vcs-diff.sh"
  LOG="$TEST_ROOT/log"
  export LOG
  for lane in node shell android ios integration integration-safe; do
    cat > "$TEST_ROOT/scripts/prepush-$lane.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0" .sh | sed 's/^prepush-//')" "$*" >> "$LOG"
exit "${STUB_FAIL:-0}"
STUB
    chmod +x "$TEST_ROOT/scripts/prepush-$lane.sh"
  done
  cat > "$TEST_ROOT/scripts/ci/record-attestations.sh" <<'STUB'
#!/usr/bin/env bash
echo attestations >> "$LOG"
STUB
  cat > "$TEST_ROOT/bin/bun" <<'STUB'
#!/usr/bin/env bash
echo "bun $*" >> "$LOG"
STUB
  chmod +x "$TEST_ROOT/scripts/ci/record-attestations.sh" "$TEST_ROOT/bin/bun"
  export PATH="$TEST_ROOT/bin:$PATH"
  export PREPUSH_CHANGED_FILES_FILE="$TEST_ROOT/changed"
  cd "$TEST_ROOT"
}

set_paths() { printf '%s\n' "$@" > "$PREPUSH_CHANGED_FILES_FILE"; }

@test "android-only list and run pass base ref" {
  set_paths android/app/src/Main.kt
  run bash scripts/prepush.sh --base main --list
  [ "$status" -eq 0 ]; [ "$output" = android ]
  run bash scripts/prepush.sh --base main
  [ "$status" -eq 0 ]; grep -q '^android --base-ref main$' "$LOG"
  [ "$(wc -l < "$LOG" | tr -d ' ')" -eq 1 ]
}

@test "node and shell selection skips duplicate format" {
  set_paths src/a.ts scripts/x.sh
  run bash scripts/prepush.sh --list
  [ "$output" = $'node\nshell' ]
  run bash scripts/prepush.sh
  [ "$status" -eq 0 ]; ! grep -q 'bun run format' "$LOG"
}

@test "shell-only runs formatter" {
  set_paths scripts/x.sh
  run bash scripts/prepush.sh
  [ "$status" -eq 0 ]; grep -q 'bun run format' "$LOG"
}

@test "ios lane runs" {
  set_paths ios/Sources/A.swift
  run bash scripts/prepush.sh
  [ "$status" -eq 0 ]; grep -q '^ios ' "$LOG"
}

@test "package and bun lock select pins, node, and integration in lane order" {
  for path in package.json bun.lock; do
    : > "$LOG"
    set_paths "$path"
    run bash scripts/prepush.sh --list
    [ "$status" -eq 0 ]
    [ "$output" = $'runtime-pins\nnode\nintegration' ]
    run bash scripts/prepush.sh
    [ "$status" -eq 0 ]
    grep -q 'bun scripts/release/pin-runtime-deps.ts --write' "$LOG"
    grep -q '^node ' "$LOG"
    grep -q '^integration ' "$LOG"
  done
}

@test "fake selects integration-safe and node" {
  set_paths test/fakes/Fake.ts
  run bash scripts/prepush.sh --list
  [ "$output" = $'node\nintegration-safe' ]
}

@test "all lanes selected and list does not invoke scripts" {
  set_paths docs/readme.md
  run bash scripts/prepush.sh --all --list
  [ "$output" = $'runtime-pins\nnode\nshell\nandroid\nios\nintegration\nintegration-safe' ]
  [ ! -f "$LOG" ]
}

@test "all selected lane scripts run once and dispatcher never records" {
  set_paths docs/readme.md
  run bash scripts/prepush.sh --all
  [ "$status" -eq 0 ]
  for lane in node shell android ios integration integration-safe; do
    [ "$(grep -c "^$lane " "$LOG")" -eq 1 ]
  done
  [ "$(grep -c '^bun scripts/release/pin-runtime-deps.ts --write$' "$LOG")" -eq 1 ]
  ! grep -q attestations "$LOG"
}

@test "docs-only has no gates" {
  set_paths docs/readme.md
  run bash scripts/prepush.sh
  [ "$status" -eq 0 ]; [[ "$output" == *'No pre-push gates selected for 1 changed paths.'* ]]
}

@test "changed forwarded only to node" {
  set_paths src/a.ts
  run bash scripts/prepush.sh --changed
  [ "$status" -eq 0 ]; grep -q '^node --changed$' "$LOG"
}

@test "fail fast and summarizes failure without duplicate attestation" {
  set_paths src/a.ts android/a.kt
  run env STUB_FAIL=1 bash scripts/prepush.sh
  [ "$status" -eq 1 ]; [[ "$output" == *'FAIL'* && "$output" == *'node'* ]]
  [ "$(wc -l < "$LOG" | tr -d ' ')" -eq 1 ]
  ! grep -q attestations "$LOG"
}

@test "unknown flag and missing explicit base return usage error" {
  run bash scripts/prepush.sh --wat
  [ "$status" -eq 2 ]
  unset PREPUSH_CHANGED_FILES_FILE
  run bash scripts/prepush.sh --base definitely-missing-ref
  [ "$status" -eq 2 ]
}
