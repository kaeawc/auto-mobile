#!/usr/bin/env bats
# The optional prebuild is concurrent, bounded, and never overrides foreground status.
SCRIPT="scripts/android/run-with-background-prebuild.sh"

setup() {
  TEST_DIR="$(mktemp -d)"
  export TEST_DIR
  # Prefer real discovery; sandboxed macOS can deny process-table reads (exit 3).
  # In that case model only our own child, retaining real termination/reaping.
  local discovery_status=0
  pgrep -P "$$" >/dev/null 2>&1 || discovery_status=$?
  if [[ "$discovery_status" -gt 1 ]]; then
    mkdir -p "$TEST_DIR/bin"
    cat > "$TEST_DIR/bin/pgrep" <<'SH'
#!/usr/bin/env bash
if [[ -f "$TEST_DIR/prebuild.pid" && -f "$TEST_DIR/child.pid" && "$2" == "$(cat "$TEST_DIR/prebuild.pid")" ]]; then
    cat "$TEST_DIR/child.pid"
else
    exit 1
fi
SH
    chmod +x "$TEST_DIR/bin/pgrep"
    export PATH="$TEST_DIR/bin:$PATH"
  fi
}

teardown() {
  # These PIDs are recorded only by processes each test starts.
  local file pid
  for file in "$TEST_DIR"/*.pid; do
    [[ -f "$file" ]] || continue
    pid="$(cat "$file")"
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$TEST_DIR"
}

run_wrapper() {
  run env AUTOMOBILE_PREBUILD_WAIT_SECONDS=2 AUTOMOBILE_PREBUILD_POLL_SECONDS=0.1 bash "$SCRIPT" "$@"
}

@test "empty prebuild only runs foreground and returns its status" {
  run_wrapper "" -- bash -c 'echo foreground; exit 7'
  [ "$status" -eq 7 ]
  [ "$output" = foreground ]
  run_wrapper "" -- bash -c 'echo success'
  [ "$status" -eq 0 ]
  [ "$output" = success ]
}

@test "prebuild failure only warns and its output is grouped" {
  run_wrapper 'echo prebuild-output; exit 3' -- bash -c 'echo foreground'
  [ "$status" -eq 0 ]
  [[ "$output" == *$'::group::Background prebuild output\nprebuild-output\n::endgroup::'* ]]
  [[ "$output" == *"::warning::background prebuild exited with status 3;"* ]]
}

@test "foreground failure wins over a successful prebuild" {
  run_wrapper 'echo complete > "$TEST_DIR/done"; echo prebuild-output' -- bash -c '
    for ((i=0; i<100; i++)); do [[ -f "$TEST_DIR/done" ]] && { sleep 0.1; exit 7; }; sleep 0.05; done
    exit 9'
  [ "$status" -eq 7 ]
  [[ "$output" == *$'::group::Background prebuild output\nprebuild-output\n::endgroup::'* ]]
  [[ "$output" == *"[prebuild] finished with exit status 0"* ]]
}

@test "foreground runs concurrently with prebuild" {
  run_wrapper '
    for ((i=0; i<100; i++)); do [[ -f "$TEST_DIR/foreground" ]] && { echo concurrent; exit 0; }; sleep 0.05; done
    exit 9' -- bash -c 'touch "$TEST_DIR/foreground"'
  [ "$status" -eq 0 ]
  [[ "$output" == *$'::group::Background prebuild output\nconcurrent\n::endgroup::'* ]]
  [[ "$output" == *"[prebuild] finished with exit status 0"* ]]
}

@test "a prebuild exceeding its wait budget and its child are terminated" {
  run env AUTOMOBILE_PREBUILD_WAIT_SECONDS=1 AUTOMOBILE_PREBUILD_POLL_SECONDS=0.1 bash "$SCRIPT" \
    'echo $$ > "$TEST_DIR/prebuild.pid"; sleep 30 & echo $! > "$TEST_DIR/child.pid"; wait' -- bash -c '
    for ((i=0; i<100; i++)); do [[ -f "$TEST_DIR/child.pid" ]] && exit 0; sleep 0.05; done
    exit 9'
  [ "$status" -eq 0 ]
  [[ "$output" == *"::warning::background prebuild did not finish within 1s; terminated"* ]]
  if kill -0 "$(cat "$TEST_DIR/prebuild.pid")" 2>/dev/null; then return 1; fi
  ! kill -0 "$(cat "$TEST_DIR/child.pid")" 2>/dev/null
}

@test "a failing foreground immediately terminates the running prebuild" {
  run_wrapper 'echo $$ > "$TEST_DIR/prebuild.pid"; sleep 30 & echo $! > "$TEST_DIR/child.pid"; wait' -- bash -c '
    for ((i=0; i<100; i++)); do [[ -f "$TEST_DIR/child.pid" ]] && exit 7; sleep 0.05; done
    exit 9'
  [ "$status" -eq 7 ]
  [[ "$output" != *"[prebuild] waiting"* ]]
  if kill -0 "$(cat "$TEST_DIR/prebuild.pid")" 2>/dev/null; then return 1; fi
  ! kill -0 "$(cat "$TEST_DIR/child.pid")" 2>/dev/null
}

@test "missing separator or foreground command exits with usage status 2" {
  run_wrapper '' bash -c true
  [ "$status" -eq 2 ]
  [[ "$output" == *"usage: run-with-background-prebuild.sh"* ]]
  run_wrapper '' --
  [ "$status" -eq 2 ]
  [[ "$output" == *"usage: run-with-background-prebuild.sh"* ]]
  run_wrapper
  [ "$status" -eq 2 ]
}
