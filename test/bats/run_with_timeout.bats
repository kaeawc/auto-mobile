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
