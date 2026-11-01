#!/usr/bin/env bats

@test "portable watchdog closes fd 3 before starting a multi-statement command" {
  probe="$BATS_TEST_TMPDIR/probe.sh"
  result="$BATS_TEST_TMPDIR/probe-result"
  inherited_fd="$BATS_TEST_TMPDIR/inherited-fd"
  cat > "$probe" <<'EOF'
#!/usr/bin/env bash
/bin/true
if { printf 'inherited\n' 2> /dev/null >&3; }; then
  printf 'open\n' > "$1"
else
  printf 'closed\n' > "$1"
fi
printf 'finished\n' > "$1.finished"
EOF
  chmod +x "$probe"

  run env AUTOMOBILE_FORCE_PORTABLE_TIMEOUT=1 bash -c '
    source scripts/ios/run_with_timeout.sh
    exec 3> "$3"
    run_with_timeout 2 "$1" "$2"
    result=$?
    exec 3>&-
    exit "$result"
  ' bash "$probe" "$result" "$inherited_fd"

  [ "$status" -eq 0 ]
  [ "$(cat "$result")" = closed ]
  [ "$(cat "$result.finished")" = finished ]
  [ ! -s "$inherited_fd" ]
}

@test "portable watchdog writes a snapshot, names the active file, and returns 124" {
  timing_log="$BATS_TEST_TMPDIR/timing.ndjson"
  snapshot="$BATS_TEST_TMPDIR/watchdog.txt"
  cat > "$timing_log" <<'EOF'
{"event":"start","file":"finished.test.ts","t":100}
{"event":"end","file":"finished.test.ts","t":110,"elapsedMs":10}
{"event":"start","file":"running.test.ts","t":111}
EOF

  run env AUTOMOBILE_FORCE_PORTABLE_TIMEOUT=1 \
    AUTOMOBILE_WATCHDOG_TIMING_LOG="$timing_log" \
    AUTOMOBILE_WATCHDOG_SNAPSHOT_FILE="$snapshot" \
    AUTOMOBILE_WATCHDOG_LABEL="unit shard 2" \
    bash -c 'source scripts/ios/run_with_timeout.sh; run_with_timeout 1 bash -c "sleep 5"'

  [ "$status" -eq 124 ]
  [ -s "$snapshot" ]
  [[ "$output" == *"WATCHDOG: unit shard 2 exceeded 1s; last started-but-not-ended file: running.test.ts"* ]]
  grep -q 'PID\|sleep' "$snapshot"
}

@test "real timeout exit 124 still names the active file" {
  timing_log="$BATS_TEST_TMPDIR/timing.ndjson"
  stub_bin="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$stub_bin"
  cat > "$stub_bin/timeout" <<'EOF'
#!/usr/bin/env bash
exit 124
EOF
  chmod +x "$stub_bin/timeout"
  printf '%s\n' '{"event":"start","file":"running.test.ts","t":100}' > "$timing_log"

  run env PATH="$stub_bin:$PATH" \
    AUTOMOBILE_WATCHDOG_TIMING_LOG="$timing_log" \
    AUTOMOBILE_WATCHDOG_LABEL="real timeout" \
    bash -c 'source scripts/ios/run_with_timeout.sh; run_with_timeout 1 true'

  [ "$status" -eq 124 ]
  [[ "$output" == *"WATCHDOG: real timeout exceeded 1s; last started-but-not-ended file: running.test.ts"* ]]
}


@test "macOS watchdog records sorted CPU RSS and pressure diagnostics despite sampler errors" {
  stub_bin="$BATS_TEST_TMPDIR/bin"
  snapshot="$BATS_TEST_TMPDIR/watchdog.txt"
  mkdir -p "$stub_bin"
  printf '#!/usr/bin/env bash\nprintf "Darwin\\n"\n' > "$stub_bin/uname"
  cat > "$stub_bin/ps" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == '-axo pid,%cpu,rss,command' ]]; then
  printf 'PID %%CPU RSS COMMAND\n1 2 100 small\n2 3 200 large\n'
else
  exec /bin/ps "$@"
fi
EOF
  cat > "$stub_bin/vm_stat" <<'EOF'
#!/usr/bin/env bash
printf 'fake vm_stat\n'
exit 42
EOF
  cat > "$stub_bin/memory_pressure" <<'EOF'
#!/usr/bin/env bash
printf 'fake memory_pressure\n'
exit 42
EOF
  chmod +x "$stub_bin/"*
  run env PATH="$stub_bin:$PATH" AUTOMOBILE_FORCE_PORTABLE_TIMEOUT=1 \
    AUTOMOBILE_WATCHDOG_SNAPSHOT_FILE="$snapshot" \
    bash -c 'source scripts/ios/run_with_timeout.sh; run_with_timeout 1 bash -c "sleep 5"'
  [ "$status" -eq 124 ]
  grep -Fq 'fake vm_stat' "$snapshot"
  grep -Fq 'fake memory_pressure' "$snapshot"
  # RSS descending; optional sampler failures do not replace timeout status.
  [ "$(sed -n '/macOS CPU\/RSS/{n;p;}' "$snapshot")" = '2 3 200 large' ]
}

@test "fractional portable deadlines still bound a long command" {
  run env AUTOMOBILE_FORCE_PORTABLE_TIMEOUT=1 \
    AUTOMOBILE_WATCHDOG_KILL_GRACE_SECONDS=0.1 \
    AUTOMOBILE_WATCHDOG_SNAPSHOT_FILE="$BATS_TEST_TMPDIR/snapshot" \
    bash -c 'source scripts/ios/run_with_timeout.sh; run_with_timeout 0.1 sleep 5'
  [[ "$status" -eq 124 ]]
}

@test "a test deadline override fires the portable watchdog early but still reports the budget (#16140)" {
  start=$SECONDS
  run env AUTOMOBILE_FORCE_PORTABLE_TIMEOUT=1 \
    AUTOMOBILE_WATCHDOG_KILL_GRACE_SECONDS=0.1 \
    AUTOMOBILE_WATCHDOG_DEADLINE_SECONDS=0.1 \
    AUTOMOBILE_WATCHDOG_SNAPSHOT_FILE="$BATS_TEST_TMPDIR/snapshot" \
    bash -c 'source scripts/ios/run_with_timeout.sh; run_with_timeout 30 sleep 20'
  [[ "$status" -eq 124 ]]
  # Far below the 30 s budget: the override, not the budget, decided when it fired.
  ((SECONDS - start < 10))
  [ -s "$BATS_TEST_TMPDIR/snapshot" ]
}

@test "fractional portable deadline preserves an early command exit status" {
  run env AUTOMOBILE_FORCE_PORTABLE_TIMEOUT=1 \
    bash -c 'source scripts/ios/run_with_timeout.sh; run_with_timeout 1.5 bash -c "exit 7"'
  [[ "$status" -eq 7 ]]
}

@test "watchdog coordination variable is private to the timeout wrapper" {
  run env AUTOMOBILE_RUN_WITH_TIMEOUT_PGID_FILE="$BATS_TEST_TMPDIR/pgid" \
    bash -c '
      source scripts/ios/run_with_timeout.sh
      run_with_timeout 5 bash -c "test -z \"\${AUTOMOBILE_RUN_WITH_TIMEOUT_PGID_FILE+x}\""
    '
  [[ "$status" -eq 0 ]]
}

@test "run_with_timeout keeps the caller's PGID file variable across calls (#14497)" {
  run env AUTOMOBILE_FORCE_PORTABLE_TIMEOUT=1 \
    AUTOMOBILE_RUN_WITH_TIMEOUT_PGID_FILE="$BATS_TEST_TMPDIR/pgid" bash -c '
    source scripts/ios/run_with_timeout.sh
    run_with_timeout 5 true || exit 10
    [ "${AUTOMOBILE_RUN_WITH_TIMEOUT_PGID_FILE:-}" = "$1/pgid" ] || exit 11
    run_with_timeout 5 true || exit 12
    [ -z "$(ls "$1" | grep "^pgid\.")" ] || exit 13
    case "$(declare -p AUTOMOBILE_RUN_WITH_TIMEOUT_PGID_FILE)" in "declare -x"*) ;; *) exit 14 ;; esac
  ' bash "$BATS_TEST_TMPDIR"
  [ "$status" -eq 0 ]
}

@test "run_with_timeout leaves the PGID file variable unset when the caller had none (#14497)" {
  run env -u AUTOMOBILE_RUN_WITH_TIMEOUT_PGID_FILE AUTOMOBILE_FORCE_PORTABLE_TIMEOUT=1 bash -c '
    source scripts/ios/run_with_timeout.sh
    run_with_timeout 5 true
    [ -z "${AUTOMOBILE_RUN_WITH_TIMEOUT_PGID_FILE+x}" ]
  '
  [ "$status" -eq 0 ]
}

@test "run_with_timeout hides the PGID file variable from the timed command (#14497)" {
  run env AUTOMOBILE_FORCE_PORTABLE_TIMEOUT=1 \
    AUTOMOBILE_RUN_WITH_TIMEOUT_PGID_FILE="$BATS_TEST_TMPDIR/pgid" bash -c '
    source scripts/ios/run_with_timeout.sh
    run_with_timeout 5 bash -c "[ -z \"\${AUTOMOBILE_RUN_WITH_TIMEOUT_PGID_FILE+x}\" ]"
  '
  [ "$status" -eq 0 ]
}

@test "portable watchdog bounds a command under a leading-zero timeout (#14498)" {
  # `08` is an invalid octal literal in $(( )); the watcher died silently and the
  # bound never applied, so the 12s command ran to completion instead of 124.
  run env AUTOMOBILE_FORCE_PORTABLE_TIMEOUT=1 AUTOMOBILE_WATCHDOG_KILL_GRACE_SECONDS=0 bash -c '
    source scripts/ios/run_with_timeout.sh
    start=$SECONDS
    run_with_timeout 08 sleep 12
    echo "rc=$? elapsed=$((SECONDS - start))"
  '
  [ "$status" -eq 0 ]
  [[ "$output" =~ rc=124\ elapsed=(8|9|10)$ ]]
}
