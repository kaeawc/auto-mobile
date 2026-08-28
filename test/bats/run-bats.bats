#!/usr/bin/env bats
#
# Tests for scripts/ci/run-bats.sh — the CI BATS runner that runs the suite in
# two passes: a cross-file-parallel pass (everything but `serial`-tagged files)
# and a serial pass (the `serial`-tagged files).

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/ci/run-bats.sh"

  # Isolated PATH shim so the script exec's our fake `bats` (which appends each
  # invocation's args) instead of the real one, and finds a fake `parallel` so
  # it never tries to install anything.
  STUB_BIN="$(mktemp -d)"
  ARGS_FILE="$(mktemp)"
  FAKE_HOME="$(mktemp -d)"

  # The runner calls bats twice; record every invocation on its own line.
  cat > "$STUB_BIN/bats" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$ARGS_FILE"
EOF
  chmod +x "$STUB_BIN/bats"

  # GNU parallel identifies itself via `--version`; the runner probes for that
  # string, so the stub must emit it or the runner would try to install.
  cat > "$STUB_BIN/parallel" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  echo "GNU parallel 20230101"
  exit 0
fi
exit 0
EOF
  chmod +x "$STUB_BIN/parallel"
}

teardown() {
  rm -rf "$STUB_BIN" "$FAKE_HOME"
  rm -f "$ARGS_FILE"
}

run_runner() {
  run env AUTOMOBILE_BATS_SERIAL_ONLY=false HOME="$FAKE_HOME" PATH="$STUB_BIN:$PATH" bash "$SCRIPT" "${1:-test/bats}"
}

# The parallel pass is the invocation carrying --jobs; the serial pass is the
# one without it.
parallel_pass_args() { grep -- '--jobs' "$ARGS_FILE"; }
serial_pass_args() { grep -v -- '--jobs' "$ARGS_FILE"; }

@test "the parallel pass runs cross-file-parallel and excludes serial-tagged files" {
  run_runner
  [ "$status" -eq 0 ]

  local args
  args="$(parallel_pass_args)"
  [[ "$args" == *"--jobs "* ]]
  [[ "$args" == *"--no-parallelize-within-files"* ]]
  [[ "$args" == *"--filter-tags !serial"* ]]
  [[ "$args" == *"test/bats"* ]]
}

@test "the serial pass runs only serial-tagged files without --jobs" {
  run_runner
  [ "$status" -eq 0 ]

  local args
  args="$(serial_pass_args)"
  [[ "$args" == *"--filter-tags serial"* ]]
  [[ "$args" != *"--jobs"* ]]
  [[ "$args" == *"test/bats"* ]]
}

@test "passes a positive integer job count to --jobs" {
  run_runner
  [ "$status" -eq 0 ]

  local jobs
  jobs="$(sed -nE 's/.*--jobs ([0-9]+).*/\1/p' "$ARGS_FILE")"
  [ -n "$jobs" ]
  [ "$jobs" -ge 1 ]
}

@test "acknowledges the GNU parallel citation to keep logs clean" {
  run_runner
  [ "$status" -eq 0 ]
  [ -f "$FAKE_HOME/.parallel/will-cite" ]
}

@test "defaults the target directory to test/bats when no argument is given" {
  run env HOME="$FAKE_HOME" PATH="$STUB_BIN:$PATH" bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$(cat "$ARGS_FILE")" == *"test/bats"* ]]
}

@test "serial-only mode runs one stable pass without GNU parallel" {
  run env AUTOMOBILE_BATS_SERIAL_ONLY=true HOME="$FAKE_HOME" PATH="$STUB_BIN:$PATH" bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [ "$(cat "$ARGS_FILE")" = "test/bats" ]
  [ ! -e "$FAKE_HOME/.parallel/will-cite" ]
}

# is_gnu_parallel must accept only GNU parallel, not the unrelated moreutils
# `parallel` (which is also named `parallel` but breaks `bats --jobs`). Source
# the script (main() is guarded) and probe the function directly.
@test "is_gnu_parallel accepts GNU parallel" {
  PATH="$STUB_BIN:$PATH" source "$SCRIPT"
  PATH="$STUB_BIN:$PATH" run is_gnu_parallel
  [ "$status" -eq 0 ]
}

@test "is_gnu_parallel rejects a non-GNU (moreutils-style) parallel" {
  # moreutils parallel does not understand --version and errors instead.
  cat > "$STUB_BIN/parallel" <<'EOF'
#!/usr/bin/env bash
echo "parallel: invalid option -- '-'" >&2
exit 1
EOF
  chmod +x "$STUB_BIN/parallel"

  source "$SCRIPT"
  PATH="$STUB_BIN:/usr/bin:/bin" run is_gnu_parallel
  [ "$status" -ne 0 ]
}
