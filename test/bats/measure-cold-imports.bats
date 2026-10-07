#!/usr/bin/env bats

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/measure-cold-imports.sh"

setup() {
  FIXTURE="$(mktemp -d)"
  mkdir -p "$FIXTURE/bin"
  # Fake bun: prints "<ms> <modules>" with a different ms per call and logs argv.
  cat >"$FIXTURE/bin/bun" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$FAKE_BUN_LOG"
n=$(wc -l <"$FAKE_BUN_LOG" | tr -d ' ')
if [[ "${FAKE_BUN_FAIL:-}" == "1" ]]; then exit 1; fi
echo "$((n * 10)).0 123"
EOF
  chmod +x "$FIXTURE/bin/bun"
  export FAKE_BUN_LOG="$FIXTURE/bun.log"
  : >"$FAKE_BUN_LOG"
  export PATH="$FIXTURE/bin:$PATH"
}

teardown() {
  rm -rf "$FIXTURE"
}

@test "defaults to four modules with five samples each" {
  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [ "$(wc -l <"$FAKE_BUN_LOG" | tr -d ' ')" -eq 20 ]
  [[ "$output" == *"src/features/action/TapOnElement.ts | 5 |"* ]]
  [[ "$output" == *"src/server/interactionTools.ts | 5 |"* ]]
}

@test "-n and explicit modules override the defaults and report median/min/max" {
  run bash "$SCRIPT" -n 3 src/a.ts

  [ "$status" -eq 0 ]
  [ "$(wc -l <"$FAKE_BUN_LOG" | tr -d ' ')" -eq 3 ]
  [[ "$output" == *"| src/a.ts | 3 | 20 | 10 | 30 | 123 |"* ]]
}

@test "rejects a non-numeric sample count" {
  run bash "$SCRIPT" -n abc

  [ "$status" -eq 2 ]
  [[ "$output" == *"SAMPLES must be a positive integer"* ]]
}

@test "rejects an unknown option" {
  run bash "$SCRIPT" -x

  [ "$status" -eq 2 ]
  [[ "$output" == *"Unknown option -x"* ]]
}

@test "-h prints usage without spawning bun" {
  run bash "$SCRIPT" -h

  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: scripts/measure-cold-imports.sh"* ]]
  [ ! -s "$FAKE_BUN_LOG" ]
}

@test "fails when a module cannot be imported" {
  FAKE_BUN_FAIL=1 run bash "$SCRIPT" -n 1 src/a.ts

  [ "$status" -eq 1 ]
  [[ "$output" == *"Failed to import src/a.ts"* ]]
}
