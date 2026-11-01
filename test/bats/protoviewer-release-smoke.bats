#!/usr/bin/env bats
# CLI contract for scripts/release/protoviewer-release-smoke.sh (#15387). bun is a PATH stub that
# records its argv, so no device, build or network is involved.

setup() {
  repo_root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  script="$repo_root/scripts/release/protoviewer-release-smoke.sh"
  work="$(mktemp -d)"
  mkdir -p "$work/stubs"
  export PATH="$work/stubs:$PATH"
  export BUN_ARGS_FILE="$work/bun-args"
  cat > "$work/stubs/bun" << 'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$BUN_ARGS_FILE"
STUB
  chmod +x "$work/stubs/bun"
  : > "$work/new.apk"
  : > "$work/old.apk"
}

teardown() {
  rm -rf "$work"
}

@test "rejects a missing or unknown platform with exit 2" {
  run bash "$script"
  [ "$status" -eq 2 ]
  run bash "$script" windows --device x
  [ "$status" -eq 2 ]
}

@test "requires a device" {
  run bash "$script" android --candidate "$work/new.apk" --mode smoke
  [ "$status" -eq 2 ]
  [[ "$output" == *"--device is required"* ]]
}

@test "upgrade and all need --previous, smoke does not" {
  run bash "$script" android --device emulator-5554 --candidate "$work/new.apk" --mode upgrade
  [ "$status" -eq 2 ]
  [[ "$output" == *"--previous is required"* ]]
  run bash "$script" android --device emulator-5554 --candidate "$work/new.apk"
  [ "$status" -eq 2 ]
  run bash "$script" android --device emulator-5554 --candidate "$work/new.apk" --mode smoke
  [ "$status" -eq 0 ]
}

@test "a missing artifact is a usage error before bun runs" {
  run bash "$script" android --device emulator-5554 --candidate "$work/none.apk" --mode smoke
  [ "$status" -eq 2 ]
  [[ "$output" == *"artifact not found"* ]]
  [ ! -e "$BUN_ARGS_FILE" ]
}

@test "forwards the platform, device, artifacts and mode to the TypeScript runner" {
  run bash "$script" ios --device UDID-1 --candidate "$work/new.apk" --previous "$work/old.apk" --mode upgrade
  [ "$status" -eq 0 ]
  mapfile -t args < "$BUN_ARGS_FILE"
  [ "${args[0]}" = "$repo_root/scripts/release/protoviewer-release-smoke.ts" ]
  [ "${args[1]}" = "ios" ]
  [[ " ${args[*]} " == *" --device UDID-1 "* ]]
  [[ " ${args[*]} " == *" --previous $work/old.apk "* ]]
  [[ " ${args[*]} " == *" --mode upgrade "* ]]
}

@test "an unknown option and an unknown mode are usage errors" {
  run bash "$script" android --device x --bogus
  [ "$status" -eq 2 ]
  run bash "$script" android --device x --candidate "$work/new.apk" --mode nightly
  [ "$status" -eq 2 ]
}

@test "Duo requires iOS and a posture command before bun runs" {
  run bash "$script" ios --device x --candidate "$work/new.apk" --mode smoke --duo
  [ "$status" -eq 2 ]
  [[ "$output" == *"--duo requires"* ]]
  run bash "$script" android --device x --candidate "$work/new.apk" --mode smoke --duo --posture-command posture
  [ "$status" -eq 2 ]
  [ ! -e "$BUN_ARGS_FILE" ]
}

@test "forwards Duo options as separate arguments including paths with spaces" {
  run bash "$script" ios --device x --candidate "$work/new.apk" --mode smoke --duo --posture-command "$work/set posture" --screenshots-dir "$work/duo images"
  [ "$status" -eq 0 ]
  mapfile -t args < "$BUN_ARGS_FILE"
  [ "${args[8]}" = "--duo" ]
  [ "${args[9]}" = "--posture-command" ]
  [ "${args[10]}" = "$work/set posture" ]
  [ "${args[11]}" = "--screenshots-dir" ]
  [ "${args[12]}" = "$work/duo images" ]
}

@test "Duo value options reject missing values" {
  for option in --posture-command --screenshots-dir; do
    run bash "$script" ios --device x --candidate "$work/new.apk" --mode smoke "$option"
    [ "$status" -eq 2 ]
    [[ "$output" == *"requires a value"* ]]
    [ ! -e "$BUN_ARGS_FILE" ]
  done
}
