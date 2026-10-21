#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  fixture="$(cd "$(mktemp -d)" && pwd -P)"
  mkdir -p "$fixture/scripts/ci" "$fixture/bin"
  cp "$REPO_ROOT/scripts/ci/record-attestations.sh" "$fixture/scripts/ci/"
  # pwd/cd are builtins; dirname is the wrapper's only external requirement.
  ln -s /usr/bin/dirname "$fixture/bin/dirname"
  export RECORDER_LOG="$fixture/args"
}
teardown() {
  rm -rf "$fixture"
}

@test "missing bun never blocks the caller" {
  run env PATH="$fixture/bin" /bin/bash "$fixture/scripts/ci/record-attestations.sh" node 'lint=pass:0'
  [ "$status" -eq 0 ]
  [[ "$output" == *"attestation skipped"* ]]
}

@test "CLI crash never blocks the caller" {
  printf '#!/bin/bash\nexit 1\n' > "$fixture/bin/bun"
  chmod +x "$fixture/bin/bun"
  run env PATH="$fixture/bin" /bin/bash "$fixture/scripts/ci/record-attestations.sh" ios 'lint=pass:0'
  [ "$status" -eq 0 ]
  [[ "$output" == *"attestation skipped"* ]]
}

@test "forwards scope note head dirtiness and gate arguments without splitting" {
  cat > "$fixture/bin/bun" <<'SCRIPT'
#!/bin/bash
printf '%s\n' "$@" > "$RECORDER_LOG"
SCRIPT
  chmod +x "$fixture/bin/bun"
  run env PATH="$fixture/bin" /bin/bash "$fixture/scripts/ci/record-attestations.sh" android \
    --scope partial --scope-note 'changed modules only' --expected-head abc --started-dirty 'module tests=skip:0'
  [ "$status" -eq 0 ]
  expected="${fixture}/scripts/ci/produce-attestations.ts"$'\n--lane\nandroid\n--scope\npartial\n--scope-note\nchanged modules only\n--expected-head\nabc\n--started-dirty\n--gate\nmodule tests=skip:0'
  [ "$(cat "$RECORDER_LOG")" = "$expected" ]
}

@test "preserves CLI usage errors" {
  printf '#!/bin/bash\nexit 2\n' > "$fixture/bin/bun"
  chmod +x "$fixture/bin/bun"
  run env PATH="$fixture/bin" /bin/bash "$fixture/scripts/ci/record-attestations.sh" node 'bad'
  [ "$status" -eq 2 ]
}
