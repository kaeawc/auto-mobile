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
