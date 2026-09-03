#!/usr/bin/env bats
#
# Pins the worker-count math of scripts/test-fast.sh (issue #5033) without
# spawning the real suite: the script honors TEST_FAST_PRINT_CMD=1 to print the
# resolved isolated-shard invocation instead of exec'ing it. CPU
# detection is mocked by shadowing `nproc`/`sysctl` on PATH.

SCRIPT="scripts/test-fast.sh"

# Write an executable `nproc` into a fresh temp dir that echoes $2, print the dir.
_mock_nproc() {
  local dir
  dir="$(mktemp -d)"
  {
    echo '#!/usr/bin/env bash'
    echo "echo $1"
  } > "$dir/nproc"
  chmod +x "$dir/nproc"
  echo "$dir"
}

@test "uses cores-2 workers when there are plenty of cores" {
  local dir
  dir="$(_mock_nproc 16)"
  run env PATH="$dir:$PATH" TEST_FAST_PRINT_CMD=1 bash "$SCRIPT"
  rm -rf "$dir"
  [ "$status" -eq 0 ]
  [[ "$output" == *"--shards=14"* ]]
}

@test "clamps to at least 1 worker on a 2-core machine" {
  local dir
  dir="$(_mock_nproc 2)"
  run env PATH="$dir:$PATH" TEST_FAST_PRINT_CMD=1 bash "$SCRIPT"
  rm -rf "$dir"
  [ "$status" -eq 0 ]
  [[ "$output" == *"--shards=1"* ]]
}

@test "clamps to at least 1 worker on a single-core machine" {
  local dir
  dir="$(_mock_nproc 1)"
  run env PATH="$dir:$PATH" TEST_FAST_PRINT_CMD=1 bash "$SCRIPT"
  rm -rf "$dir"
  [ "$status" -eq 0 ]
  [[ "$output" == *"--shards=1"* ]]
}

@test "passes through extra arguments to bun test" {
  local dir
  dir="$(_mock_nproc 8)"
  run env PATH="$dir:$PATH" TEST_FAST_PRINT_CMD=1 bash "$SCRIPT" test/scripts/testLaneClassification.test.ts
  rm -rf "$dir"
  [ "$status" -eq 0 ]
  [[ "$output" == *"--parallel=6"* ]]
  [[ "$output" == *"test/scripts/testLaneClassification.test.ts"* ]]
}

@test "falls back to sysctl when nproc is unavailable" {
  local dir
  dir="$(mktemp -d)"
  # A failing `nproc` (shadowing any real one) forces the fallback; the sysctl
  # mock supplies the core count. The real PATH is appended so `bash` resolves.
  {
    echo '#!/usr/bin/env bash'
    echo 'exit 1'
  } > "$dir/nproc"
  {
    echo '#!/usr/bin/env bash'
    echo 'if [ "$1" = "-n" ] && [ "$2" = "hw.ncpu" ]; then echo 10; fi'
  } > "$dir/sysctl"
  chmod +x "$dir/nproc" "$dir/sysctl"
  run env PATH="$dir:$PATH" TEST_FAST_PRINT_CMD=1 bash "$SCRIPT"
  rm -rf "$dir"
  [ "$status" -eq 0 ]
  [[ "$output" == *"--shards=8"* ]]
}
