#!/usr/bin/env bats
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
  STUB_DIR="$(mktemp -d)"
  WORK_DIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$STUB_DIR" "$WORK_DIR"
  rm -rf coverage
}

# Stub `bun` to emit a canned coverage log ($STUB_LOG) and exit non-zero,
# simulating the WriteFailed crash after tests ran.
make_bun_stub() {
  cat > "$STUB_DIR/bun" <<EOF
#!/usr/bin/env bash
mkdir -p coverage
printf 'TN:\n' > coverage/lcov.info
cat "$STUB_LOG"
exit 1
EOF
  chmod +x "$STUB_DIR/bun"
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
