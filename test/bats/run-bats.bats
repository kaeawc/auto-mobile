#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/ci/run-bats.sh"
  STUB_BIN="$(mktemp -d)"
  FIXTURES="$(mktemp -d)"
  ARGS_FILE="$(mktemp)"
  FAKE_HOME="$(mktemp -d)"

cat > "$STUB_BIN/bats" <<EOF
#!/usr/bin/env bash
printf 'bats:%s\n' "\$1" >> "$ARGS_FILE"
case "\$1" in
  *signal-pass*|*signal-column-pass*)
    printf '1..2\nok 1 first\nok 2 second\n'
    kill -TERM "\$\$"
    ;;
  *not-ok*) printf '1..1\nnot ok 1 real failure\n' ;;
  *fail*)
    printf '1..1\nok 1 stub failure\n'
    exit 1
    ;;
  *) printf '1..1\nok 1 stub pass\n' ;;
esac
EOF

  cat > "$STUB_BIN/parallel" <<EOF
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  echo "GNU parallel 20230101"
  exit 0
fi
printf 'parallel:%s\n' "\$*" >> "$ARGS_FILE"
joblog=""
args=("\$@")
for ((i = 0; i < \${#args[@]}; i += 1)); do
  if [[ "\${args[\$i]}" == "--joblog" ]]; then
    joblog="\${args[\$((i + 1))]}"
  fi
done
if [[ -n "\$joblog" ]]; then
  printf 'Seq Host Starttime JobRuntime Send Receive Exitval Signal Command\n' > "\$joblog"
fi
rc=0
sequence=0
command=""
for ((i = 0; i < \${#args[@]}; i += 1)); do
  if [[ "\${args[\$i]}" == "-0" ]]; then
    command="\${args[\$((i + 1))]}"
  fi
done
if [[ "\$command" =~ \>\ \"([^\"]+)\"/\\{#\\}\.out ]]; then
  output_dir="\${BASH_REMATCH[1]}"
else
  exit 2
fi
while IFS= read -r -d '' file; do
  sequence=\$((sequence + 1))
  "$STUB_BIN/bats" "\$file" > "\$output_dir/\${sequence}.out" 2>&1
  bats_status=\$?
  exitval=\$bats_status
  signal=0
  if [[ "\$file" == *signal-column-pass* ]] && (( bats_status > 128 )); then
    signal=\$((bats_status - 128))
  fi
  printf '%s : 0 2.000 0 0 %s %s bats %s\n' "\$sequence" "\$exitval" "\$signal" "\$file" >> "\$joblog"
  if (( bats_status != 0 )); then
    rc=1
  fi
done
exit "\$rc"
EOF
  chmod +x "$STUB_BIN/bats" "$STUB_BIN/parallel"

  printf '@test "unit" { true; }\n' > "$FIXTURES/unit.bats"
  printf '# bats file_tags=serial\n@test "serial" { true; }\n' > "$FIXTURES/serial.bats"
  printf '# bats file_tags=integration\n@test "integration" { true; }\n' \
    > "$FIXTURES/integration.bats"
  printf '# bats file_tags=serial,integration\n@test "both" { true; }\n' \
    > "$FIXTURES/integration-serial.bats"
}

teardown() {
  rm -rf "$STUB_BIN" "$FIXTURES" "$FAKE_HOME"
  rm -f "$ARGS_FILE"
}

run_runner() {
  run env \
    HOME="$FAKE_HOME" \
    PATH="$STUB_BIN:$PATH" \
    AUTOMOBILE_BATS_JOBLOG="$FIXTURES/joblog.tsv" \
    bash "$SCRIPT" "$@" "$FIXTURES"
}

@test "unit lane executes every non-integration file exactly once" {
  run_runner unit
  [ "$status" -eq 0 ]
  [ "$(grep -c "^bats:$FIXTURES/unit.bats$" "$ARGS_FILE")" -eq 1 ]
  [ "$(grep -c "^bats:$FIXTURES/serial.bats$" "$ARGS_FILE")" -eq 1 ]
  ! grep -q "^bats:$FIXTURES/integration.bats$" "$ARGS_FILE"
  ! grep -q "^bats:$FIXTURES/integration-serial.bats$" "$ARGS_FILE"
}

@test "integration lane executes tagged files exactly once" {
  run_runner integration
  [ "$status" -eq 0 ]
  [ "$(grep -c "^bats:$FIXTURES/integration.bats$" "$ARGS_FILE")" -eq 1 ]
  [ "$(grep -c "^bats:$FIXTURES/integration-serial.bats$" "$ARGS_FILE")" -eq 1 ]
  ! grep -q "^bats:$FIXTURES/unit.bats$" "$ARGS_FILE"
  ! grep -q "^bats:$FIXTURES/serial.bats$" "$ARGS_FILE"
}

@test "fails closed when a lane selects no BATS files" {
  rm "$FIXTURES/integration.bats" "$FIXTURES/integration-serial.bats"

  run_runner integration

  [ "$status" -eq 1 ]
  [[ "$output" == *"no BATS files selected for integration lane"* ]]
  ! grep -q '^bats:' "$ARGS_FILE"
}

@test "fails closed when the BATS directory is missing" {
  run env \
    HOME="$FAKE_HOME" \
    PATH="$STUB_BIN:$PATH" \
    AUTOMOBILE_BATS_JOBLOG="$FIXTURES/joblog.tsv" \
    bash "$SCRIPT" unit "$FIXTURES/missing"

  [ "$status" -eq 1 ]
  [[ "$output" == *"no BATS files selected for unit lane"* ]]
  ! grep -q '^bats:' "$ARGS_FILE"
}

@test "parallel and serial failures propagate" {
  printf '@test "fail" { false; }\n' > "$FIXTURES/parallel-fail.bats"
  printf '# bats file_tags=serial\n@test "fail" { false; }\n' > "$FIXTURES/serial-fail.bats"
  run_runner unit
  [ "$status" -ne 0 ]
  grep -q "^bats:$FIXTURES/parallel-fail.bats$" "$ARGS_FILE"
  grep -q "^bats:$FIXTURES/serial-fail.bats$" "$ARGS_FILE"
}

@test "parallel shell-wrapper exit after a complete TAP plan is treated as pass" {
  printf '@test "signal pass" { true; }\n' > "$FIXTURES/parallel-signal-pass.bats"

  run_runner unit

  [ "$status" -eq 0 ]
  [[ "$output" == *"parallel-signal-pass.bats plan complete despite trailing signal 15; treating as pass"* ]]
}

@test "parallel Signal-column termination after a complete TAP plan is treated as pass" {
  printf '@test "signal column pass" { true; }\n' > "$FIXTURES/parallel-signal-column-pass.bats"

  run_runner unit

  [ "$status" -eq 0 ]
  [[ "$output" == *"parallel-signal-column-pass.bats plan complete despite trailing signal 15; treating as pass"* ]]
}

@test "parallel TAP not ok fails even when bats exits zero" {
  printf '@test "not ok" { false; }\n' > "$FIXTURES/parallel-not-ok.bats"

  run_runner unit

  [ "$status" -ne 0 ]
  [[ "$output" == *"parallel-not-ok.bats did not produce a complete passing BATS TAP plan"* ]]
}

@test "job count override reaches GNU Parallel" {
  run env \
    HOME="$FAKE_HOME" \
    PATH="$STUB_BIN:$PATH" \
    AUTOMOBILE_BATS_JOBS=7 \
    AUTOMOBILE_BATS_JOBLOG="$FIXTURES/joblog.tsv" \
    bash "$SCRIPT" unit "$FIXTURES"
  [ "$status" -eq 0 ]
  grep -q "parallel:.*--jobs 7" "$ARGS_FILE"
}

@test "unit file budget fails with an actionable classification message" {
  run env \
    HOME="$FAKE_HOME" \
    PATH="$STUB_BIN:$PATH" \
    AUTOMOBILE_BATS_MAX_FILE_SECONDS=1 \
    AUTOMOBILE_BATS_JOBLOG="$FIXTURES/joblog.tsv" \
    bash "$SCRIPT" unit "$FIXTURES"
  [ "$status" -ne 0 ]
  [[ "$output" == *"tag genuine real-I/O coverage as integration"* ]]
}

@test "rejects an invalid lane" {
  run_runner nope
  [ "$status" -eq 2 ]
  [[ "$output" == *"Usage:"* ]]
}

@test "is_gnu_parallel accepts GNU parallel" {
  PATH="$STUB_BIN:$PATH" source "$SCRIPT"
  PATH="$STUB_BIN:$PATH" run is_gnu_parallel
  [ "$status" -eq 0 ]
}

@test "is_gnu_parallel rejects a non-GNU parallel" {
  cat > "$STUB_BIN/parallel" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
  chmod +x "$STUB_BIN/parallel"
  source "$SCRIPT"
  PATH="$STUB_BIN:/usr/bin:/bin" run is_gnu_parallel
  [ "$status" -ne 0 ]
}
