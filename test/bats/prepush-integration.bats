#!/usr/bin/env bats

ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SCRIPT="$ROOT/scripts/prepush-integration.sh"
FIXTURE="test/daemon/socketServerKeyValue.integration.test.ts"
FIXTURE_BACKUP=""
MODIFIED_FILES=()
BACKUP_DIR=""

teardown() {
  if [[ -n "$FIXTURE_BACKUP" ]]; then
    cp "$FIXTURE_BACKUP" "$FIXTURE"
  fi
  if [[ -n "$BACKUP_DIR" ]]; then
    local file
    for file in "${MODIFIED_FILES[@]}"; do
      cp "$BACKUP_DIR/${file//\//_}" "$file"
    done
  fi
}

@test "runs only an affected integration file and skips unchanged runtime inputs" {
  FIXTURE_BACKUP="$BATS_TEST_TMPDIR/socket-server-key-value.backup"
  cp "$FIXTURE" "$FIXTURE_BACKUP"
  base_ref="$(git -C "$ROOT" rev-parse HEAD)"
  printf '\n// prepush fixture\n' >> "$FIXTURE"

  run env TEST_TS_PRINT_CMD=1 AUTOMOBILE_INTEGRATION_TEST_BASE_REF="$base_ref" bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Integration tests: running 1 affected file(s)."* ]]
  [[ "$output" == *"$FIXTURE"* ]]
  [[ "$output" == *"Pinned runtime graph: skipped"* ]]
}

@test "runs the pinned runtime graph audit for every runtime graph input" {
  local runtime_input base_ref fake_bin
  local -a runtime_inputs=(
    scripts/release/runtime-graph.json
    scripts/release/lib/runtime-pins.ts
    scripts/release/lib/runtime-roots.ts
    scripts/ci/verify-pinned-runtime-graph.sh
  )

  BACKUP_DIR="$BATS_TEST_TMPDIR/runtime-input-backups"
  mkdir -p "$BACKUP_DIR"
  fake_bin="$BATS_TEST_TMPDIR/runtime-graph-bin"
  mkdir -p "$fake_bin"
  cat > "$fake_bin/bash" <<'SHIM'
#!/bin/bash
if [[ "$1" == scripts/ci/verify-pinned-runtime-graph.sh ]]; then
  exit 0
fi
exec /bin/bash "$@"
SHIM
  cat > "$fake_bin/bun" <<'SHIM'
#!/bin/bash
exit 0
SHIM
  chmod +x "$fake_bin/bash" "$fake_bin/bun"
  for runtime_input in "${runtime_inputs[@]}"; do
    cp "$runtime_input" "$BACKUP_DIR/${runtime_input//\//_}"
    MODIFIED_FILES+=("$runtime_input")
  done

  for runtime_input in "${runtime_inputs[@]}"; do
    base_ref="$(git -C "$ROOT" rev-parse HEAD)"
    printf '\n' >> "$runtime_input"

    run env PATH="$fake_bin:$PATH" AUTOMOBILE_INTEGRATION_TEST_BASE_REF="$base_ref" /bin/bash "$SCRIPT"

    [ "$status" -eq 0 ]
    [[ "$output" == *"Pinned runtime graph: running"* ]]
    cp "$BACKUP_DIR/${runtime_input//\//_}" "$runtime_input"
  done
}

@test "fails when the integration base ref cannot be resolved" {
  run env AUTOMOBILE_INTEGRATION_TEST_BASE_REF=definitely-no-such-ref bash "$SCRIPT"

  [ "$status" -ne 0 ]
  [[ "$output" == *"Revision 'definitely-no-such-ref' does not exist"* ]]
  [[ "$output" != *"no changed test/**/*.integration.test.ts files"* ]]
}
