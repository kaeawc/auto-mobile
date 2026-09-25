#!/usr/bin/env bats

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
