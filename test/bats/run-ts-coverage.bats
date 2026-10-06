#!/usr/bin/env bats
# bats file_tags=serial
# Both coverage tests own the shared repo-relative `coverage/` directory, so
# they must not run in parallel with each other.
#
# Tests for scripts/ci/run-ts-coverage.sh
#
# Regression guard for #3639: the WriteFailed-recovery guard must only treat a
# run as passing when it had ZERO failures. The old `rg -q '0 fail'` matched
# `10 fail`, `20 fail`, etc. as a substring, turning a genuinely failing test
# run (that also hit the known Bun WriteFailed crash) into a green CI step.

SCRIPT="scripts/ci/run-ts-coverage.sh"

setup() {
  command -v rg >/dev/null 2>&1 || skip "ripgrep (rg) not installed"
  REAL_BUN="$(command -v bun)"
  export REAL_BUN
  export AUTOMOBILE_COVERAGE_CHUNK_FILES=2
  STUB_DIR="$(mktemp -d)"
  WORK_DIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$STUB_DIR" "$WORK_DIR"
  rm -rf coverage
}

# Stub `bun` to emit a canned coverage log ($STUB_LOG) and exit non-zero,
# simulating the WriteFailed crash after tests ran. The coverage lane runs its
# files in chunks (#10213), so this stands in for every chunk's `bun test`: it
# leaves each chunk's lcov and JUnit behind like the real run does.
make_bun_stub() {
  cat > "$STUB_DIR/bun" <<EOF
#!/usr/bin/env bash
case "\$1" in
  scripts/lib/*.ts | */test-file-timings.ts) exec "$REAL_BUN" "\$@" ;;
esac
mkdir -p coverage
printf 'TN:\n' > coverage/lcov.info
while [[ "\$#" -gt 0 ]]; do
  if [[ "\$1" == --reporter-outfile ]]; then
    dir="\${2%.xml}"
    mkdir -p "\$dir"
    printf 'TN:\nSF:src/a.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n' > "\$dir/lcov.info"
    printf '<testsuites tests="1"><testsuite name="s" tests="1"><testcase name="c" classname="s" file="f" time="0"/></testsuite></testsuites>\n' > "\$2"
  fi
  shift
done
cat "$STUB_LOG"
exit 1
EOF
  chmod +x "$STUB_DIR/bun"
  # Six files in chunks of two: two chunks per shard (2+1 files), so recovery spans chunks.
  cat > "$STUB_DIR/find" <<'EOF'
#!/usr/bin/env bash
for ((i = 0; i < 6; i += 1)); do printf 'test/fixture%02d.test.ts\n' "$i"; done
EOF
  chmod +x "$STUB_DIR/find"
}

@test "recovers (exit 0) when WriteFailed follows a fully-passing run (0 fail)" {
  STUB_LOG="$WORK_DIR/pass.log"
  printf ' 42 pass\n 0 fail\nerror: An internal error occurred (WriteFailed)\n' > "$STUB_LOG"
  make_bun_stub

  run env PATH="$STUB_DIR:$PATH" bash "$SCRIPT" "$WORK_DIR/out.log"
  [ "$status" -eq 0 ]
}

@test "does NOT recover (exit non-zero) when WriteFailed follows real failures (10 fail)" {
  STUB_LOG="$WORK_DIR/fail.log"
  printf ' 32 pass\n 10 fail\nerror: An internal error occurred (WriteFailed)\n' > "$STUB_LOG"
  make_bun_stub

  run env PATH="$STUB_DIR:$PATH" bash "$SCRIPT" "$WORK_DIR/out.log"
  [ "$status" -ne 0 ]
}

@test "prints failing test names before the coverage tail on failure" {
  STUB_LOG="$WORK_DIR/coverage-failure.log"
  {
    printf '(fail) test/server/example.test.ts > identifies flaky behavior\n'
    printf 'expect(received).toBe(expected)\n'
    for i in $(seq 1 260); do
      printf 'coverage/file-%03d.ts | 100.00 | 100.00 | 100.00 | 100.00\n' "$i"
    done
    printf ' 1 fail\n'
  } > "$STUB_LOG"
  make_bun_stub

  run env PATH="$STUB_DIR:$PATH" bash "$SCRIPT" "$WORK_DIR/out.log"
  [ "$status" -ne 0 ]
  [[ "$output" == *"(fail) test/server/example.test.ts > identifies flaky behavior"* ]]
}

@test "re-emits the coverage wall budget annotation after a timed-out run's tail" {
  cat > "$STUB_DIR/timeout" <<'EOF'
#!/usr/bin/env bash
for ((i = 0; i < 260; i++)); do
  printf 'shard test output %s\n' "$i"
done
exit 124
EOF
  chmod +x "$STUB_DIR/timeout"

  run env -u AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS PATH="$STUB_DIR:$PATH" \
    RUNNER_OS=Linux bash "$SCRIPT" "$WORK_DIR/out.log"
  [ "$status" -eq 124 ]
  [[ "$output" == *"::error::coverage: Coverage test run exceeded its 720s wall-clock budget (shard 1/2)"* ]]
  [[ "$output" == *"shard test output 259"*"::error::coverage:"* ]]
}

@test "annotates every shard's WATCHDOG line, not only the last shard's" {
  # The stubbed watchdog writes each shard's timing log (as the probe would),
  # then reports a timeout, so run_with_timeout prints one WATCHDOG line per shard.
  cat > "$STUB_DIR/timeout" <<'EOF'
#!/usr/bin/env bash
printf '{"event":"start","file":"test/stuck%s.test.ts","t":1}\n' "${AUTOMOBILE_WATCHDOG_LABEL##* }" \
  > "$AUTOMOBILE_WATCHDOG_TIMING_LOG"
for ((i = 0; i < 260; i++)); do printf 'filler output %s\n' "$i"; done
exit 124
EOF
  chmod +x "$STUB_DIR/timeout"
  cat > "$STUB_DIR/find" <<'EOF'
#!/usr/bin/env bash
for ((i = 0; i < 6; i += 1)); do printf 'test/fixture%02d.test.ts\n' "$i"; done
EOF
  chmod +x "$STUB_DIR/find"

  run env -u AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS PATH="$STUB_DIR:$PATH" \
    RUNNER_OS=Linux bash "$SCRIPT" "$WORK_DIR/out.log"
  [ "$status" -eq 124 ]
  [[ "$output" == *"::error::coverage: WATCHDOG: coverage shard 1/2 exceeded 720s; last started-but-not-ended file: test/stuck1/2.test.ts"* ]]
  [[ "$output" == *"::error::coverage: WATCHDOG: coverage shard 2/2 exceeded 720s; last started-but-not-ended file: test/stuck2/2.test.ts"* ]]
}

@test "prints the tail of each failing chunk and annotates its FAIL line" {
  STUB_LOG="$WORK_DIR/chunk-failure.log"
  {
    printf '(fail) test/fixture00.test.ts > breaks\n'
    for i in $(seq 1 80); do printf 'chunk detail line %03d\n' "$i"; done
    printf ' 1 fail\n'
  } > "$STUB_LOG"
  make_bun_stub

  run env PATH="$STUB_DIR:$PATH" bash "$SCRIPT" "$WORK_DIR/out.log"
  [ "$status" -ne 0 ]
  [[ "$output" == *"::group::Unclean coverage log: coverage/shards/shard-1-chunk-1.log"* ]]
  [[ "$output" == *"::group::Unclean coverage log: coverage/shards/shard-2-chunk-2.log"* ]]
  [[ "$output" == *"::error::coverage: FAIL: coverage shard 1 chunk 1/2 exited with status 1"* ]]
  [[ "$output" == *"::error::coverage: FAIL: coverage shard 2 chunk 2/2 exited with status 1"* ]]
}
