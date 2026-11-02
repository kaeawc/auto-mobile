#!/usr/bin/env bats
#
# Tests for scripts/android/lmk-pressure-emulator-smoke.sh (#16402): the CI
# check that the x86_64 memory-pressure payload actually runs on an x86_64
# emulator. A fake adb models the device so every outcome is deterministic.

SCRIPT="scripts/android/lmk-pressure-emulator-smoke.sh"

setup() {
  BIN_DIR="$BATS_TEST_TMPDIR/build"
  mkdir -p "$BIN_DIR/x86_64"
  printf 'payload' > "$BIN_DIR/x86_64/lmk_pressure"
  export FAKE_STATE="$BATS_TEST_TMPDIR/device"
  mkdir -p "$FAKE_STATE"
  export FAKE_ABI="x86_64" FAKE_READY="READY 64" FAKE_UID="2000" FAKE_EXIT_CHECKS=0
  export ADB_LOG="$BATS_TEST_TMPDIR/adb.log"
  export ADB="$BATS_TEST_TMPDIR/adb"
  cat > "$ADB" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$ADB_LOG"
case "$1" in
  push) touch "$FAKE_STATE/pushed"; exit 0 ;;
  shell) ;;
  *) exit 0 ;;
esac
shift
cmd="$*"
case "$cmd" in
  "getprop ro.product.cpu.abi") echo "$FAKE_ABI" ;;
  nohup*) touch "$FAKE_STATE/running"; echo 4242 ;;
  "cat /data/local/tmp/automobile-lmk-pressure-smoke.out"*) [ -f "$FAKE_STATE/running" ] && echo "$FAKE_READY" ;;
  "grep Uid /proc/4242/status"*) [ -f "$FAKE_STATE/running" ] && printf 'Uid:\t%s\t%s\t%s\t%s\n' "$FAKE_UID" "$FAKE_UID" "$FAKE_UID" "$FAKE_UID" ;;
  "kill 4242"*) touch "$FAKE_STATE/killed" ;;
  "test -d /proc/4242"*)
    # A killed process lingers for FAKE_EXIT_CHECKS checks before it is gone.
    if [ -f "$FAKE_STATE/killed" ]; then
      checks=$(($(cat "$FAKE_STATE/exit-checks" 2>/dev/null || echo 0) + 1))
      echo "$checks" > "$FAKE_STATE/exit-checks"
      if [ "$checks" -gt "$FAKE_EXIT_CHECKS" ]; then rm -f "$FAKE_STATE/running"; fi
    fi
    [ -f "$FAKE_STATE/running" ] ;;
  "rm -f"*) rm -f "$FAKE_STATE/pushed" ;;
  *) ;;
esac
EOF
  chmod +x "$ADB"
  export SMOKE_POLL_SECONDS=0.01 SMOKE_READY_ATTEMPTS=3
}

@test "runs the x86_64 binary to READY as the shell user, then stops and removes it" {
  run bash "$SCRIPT" "$BIN_DIR"
  [ "$status" -eq 0 ]
  [[ "$output" == *"PASS: x86_64 lmk-pressure payload reached READY 64 as uid 2000"* ]]
  grep -Fq "push $BIN_DIR/x86_64/lmk_pressure /data/local/tmp/automobile-lmk-pressure-smoke" "$ADB_LOG"
  [ ! -f "$FAKE_STATE/running" ]
  [ ! -f "$FAKE_STATE/pushed" ]
}

@test "waits for a killed payload to exit instead of checking only once" {
  FAKE_EXIT_CHECKS=2 run bash "$SCRIPT" "$BIN_DIR"
  [ "$status" -eq 0 ]
  [[ "$output" == *"PASS: x86_64 lmk-pressure payload reached READY 64"* ]]
}

@test "fails when a killed payload never exits" {
  FAKE_EXIT_CHECKS=99 run bash "$SCRIPT" "$BIN_DIR"
  [ "$status" -ne 0 ]
  [[ "$output" == *"payload 4242 is still running after kill"* ]]
}

@test "refuses a device that is not x86_64" {
  FAKE_ABI="arm64-v8a" run bash "$SCRIPT" "$BIN_DIR"
  [ "$status" -ne 0 ]
  [[ "$output" == *"expected an x86_64 device, got arm64-v8a"* ]]
  [ ! -f "$FAKE_STATE/pushed" ]
}

@test "fails when the payload never reports READY, and still cleans up" {
  FAKE_READY="Segmentation fault" run bash "$SCRIPT" "$BIN_DIR"
  [ "$status" -ne 0 ]
  [[ "$output" == *"did not report READY 64"* ]]
  [[ "$output" == *"Segmentation fault"* ]]
  [ -f "$FAKE_STATE/killed" ]
  [ ! -f "$FAKE_STATE/pushed" ]
}

@test "fails when the payload does not run as the shell user" {
  FAKE_UID="0" run bash "$SCRIPT" "$BIN_DIR"
  [ "$status" -ne 0 ]
  [[ "$output" == *"runs as uid 0, expected 2000"* ]]
  [ -f "$FAKE_STATE/killed" ]
}

@test "fails when the built x86_64 binary is missing" {
  rm "$BIN_DIR/x86_64/lmk_pressure"
  run bash "$SCRIPT" "$BIN_DIR"
  [ "$status" -ne 0 ]
  [[ "$output" == *"x86_64/lmk_pressure not found"* ]]
}

@test "the pull-request job sets up AutoMobile before the emulator action boots through it" {
  # boot-emulator.sh boots with `bun run src/index.ts`, so Bun and the
  # repository dependencies must be installed first (#16413 review).
  run bun -e '
    const yaml = require("js-yaml");
    const fs = require("fs");
    const job = yaml.load(fs.readFileSync(".github/workflows/pull_request.yml", "utf8")).jobs["lmk-pressure-x86_64-emulator-smoke"];
    const uses = job.steps.map((step) => step.uses ?? "");
    const setup = uses.indexOf("./.github/actions/setup-auto-mobile-npm-package");
    const emulator = uses.indexOf("./.github/actions/android-emulator");
    console.log(setup >= 0 && emulator > setup ? "ordered" : `setup=${setup} emulator=${emulator}`);
  '
  [ "$status" -eq 0 ]
  [ "$output" = "ordered" ]
}
