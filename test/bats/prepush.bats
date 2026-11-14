#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  TEST_ROOT="$(mktemp -d)"
  mkdir -p "$TEST_ROOT/scripts/lib" "$TEST_ROOT/scripts/ci" "$TEST_ROOT/bin"
  cp "$REPO_ROOT/scripts/prepush.sh" "$TEST_ROOT/scripts/prepush.sh"
  cp "$REPO_ROOT/scripts/lib/vcs-diff.sh" "$TEST_ROOT/scripts/lib/vcs-diff.sh"
  LOG="$TEST_ROOT/log"
  export LOG
  for lane in node shell android ios integration integration-safe; do
    cat > "$TEST_ROOT/scripts/prepush-$lane.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0" .sh | sed 's/^prepush-//')" "$*" >> "$LOG"
exit "${STUB_FAIL:-0}"
STUB
    chmod +x "$TEST_ROOT/scripts/prepush-$lane.sh"
  done
  cat > "$TEST_ROOT/scripts/ci/record-attestations.sh" <<'STUB'
#!/usr/bin/env bash
echo attestations >> "$LOG"
STUB
  cat > "$TEST_ROOT/bin/bun" <<'STUB'
#!/usr/bin/env bash
echo "bun $*" >> "$LOG"
STUB
  chmod +x "$TEST_ROOT/scripts/ci/record-attestations.sh" "$TEST_ROOT/bin/bun"
  export PATH="$TEST_ROOT/bin:$PATH"
  export PREPUSH_CHANGED_FILES_FILE="$TEST_ROOT/changed"
  cd "$TEST_ROOT"
}

set_paths() { printf '%s\n' "$@" > "$PREPUSH_CHANGED_FILES_FILE"; }

@test "android-only list and run pass base ref" {
  set_paths android/app/src/Main.kt
  run bash scripts/prepush.sh --base main --list
  [ "$status" -eq 0 ]; [ "$output" = android ]
  run bash scripts/prepush.sh --base main
  [ "$status" -eq 0 ]; grep -q '^android --base-ref main$' "$LOG"
  [ "$(wc -l < "$LOG" | tr -d ' ')" -eq 1 ]
}

@test "node and shell selection skips duplicate format" {
  set_paths src/a.ts scripts/x.sh
  run bash scripts/prepush.sh --list
  [ "$output" = $'node\nshell' ]
  run bash scripts/prepush.sh
  [ "$status" -eq 0 ]; ! grep -q 'bun run format' "$LOG"
}

@test "agent benchmark suites and prompts select the node lane" {
  set_paths benchmark/agent/suites/bug-repro.yml benchmark/agent/prompts/bug-repro.txt
  run bash scripts/prepush.sh --list
  [ "$status" -eq 0 ]; [ "$output" = node ]
}

@test "python sdk selects the shell lane" {
  set_paths sdk/python/src/auto_mobile/session.py
  run bash scripts/prepush.sh --list
  [ "$status" -eq 0 ]; [ "$output" = shell ]
}

@test "shell-only runs formatter" {
  set_paths scripts/x.sh
  run bash scripts/prepush.sh
  [ "$status" -eq 0 ]; grep -q 'bun run format' "$LOG"
}

@test "ios lane runs" {
  set_paths ios/Sources/A.swift
  run bash scripts/prepush.sh
  [ "$status" -eq 0 ]; grep -q '^ios ' "$LOG"
}

@test "package and bun lock select pins, node, shell, and integration in lane order" {
  for path in package.json bun.lock; do
    : > "$LOG"
    set_paths "$path"
    run bash scripts/prepush.sh --list
    [ "$status" -eq 0 ]
    [ "$output" = $'runtime-pins\nnode\nshell\nintegration' ]
    run bash scripts/prepush.sh
    [ "$status" -eq 0 ]
    grep -q 'bun scripts/release/pin-runtime-deps.ts --write' "$LOG"
    grep -q '^node ' "$LOG"
    grep -q '^integration ' "$LOG"
  done
}

@test "fake selects integration-safe and node" {
  set_paths test/fakes/Fake.ts
  run bash scripts/prepush.sh --list
  [ "$output" = $'node\nintegration-safe' ]
}

@test "all lanes selected and list does not invoke scripts" {
  set_paths docs/readme.md
  run bash scripts/prepush.sh --all --list
  [ "$output" = $'runtime-pins\nnode\nshell\nandroid\nios\nintegration\nintegration-safe' ]
  [ ! -f "$LOG" ]
}

@test "all selected lane scripts run once and dispatcher never records" {
  set_paths docs/readme.md
  run bash scripts/prepush.sh --all
  [ "$status" -eq 0 ]
  for lane in node shell android ios integration integration-safe; do
    [ "$(grep -c "^$lane " "$LOG")" -eq 1 ]
  done
  [ "$(grep -c '^bun scripts/release/pin-runtime-deps.ts --write$' "$LOG")" -eq 1 ]
  ! grep -q attestations "$LOG"
}

@test "a path no lane validates has no gates" {
  set_paths LICENSE
  run bash scripts/prepush.sh
  [ "$status" -eq 0 ]; [[ "$output" == *'No pre-push gates selected for 1 changed paths.'* ]]
}

@test "docs, skills, workflow, XML and test-plan paths select the shell lane" {
  # Each is a path scripts/prepush-shell.sh (CI's required "Shell Changed
  # Files" job) selects a check for; none selected a lane before.
  for path in docs/how-it-works/ci/a.md docs/using/a.md mkdocs.yml docs-assets/src/a.ts CHANGELOG.md \
    .github/workflows/a.yml .github/actions/a/action.yml .github/CONTRIBUTING.md .githooks/pre-push \
    skills/a/SKILL.md .agents/skills/a/SKILL.md AGENTS.md .claude/commands/a.md .claude-plugin/plugin.json \
    plugins/a/x.json Dockerfile android/app/src/main/res/values/strings.xml test/test-plans/a.yaml \
    .gitattributes ios/a/.gitattributes scripts/shellcheck/sete-baseline.txt scripts/ci/known-flakes.txt; do
    set_paths "$path"
    run bash scripts/prepush.sh --list
    [ "$status" -eq 0 ]
    [[ $'\n'"$output"$'\n' == *$'\nshell\n'* ]] || { echo "no shell lane for $path: $output"; return 1; }
  done
}

@test "docs-only runs the shell lane and its formatter" {
  set_paths docs/readme.md
  run bash scripts/prepush.sh
  [ "$status" -eq 0 ]
  grep -q '^shell --base origin/main$' "$LOG"
  grep -q 'bun run format' "$LOG"
}

@test "scripts TypeScript selects node and shell" {
  set_paths scripts/prototype/generate-prototype-spec-models.ts
  run bash scripts/prepush.sh --list
  [ "$status" -eq 0 ]; [ "$output" = $'node\nshell' ]
}

@test "changed forwarded only to node" {
  set_paths src/a.ts
  run bash scripts/prepush.sh --changed
  [ "$status" -eq 0 ]; grep -q '^node --changed$' "$LOG"
}

@test "fail fast and summarizes failure without duplicate attestation" {
  set_paths src/a.ts android/a.kt
  run env STUB_FAIL=1 bash scripts/prepush.sh
  [ "$status" -eq 1 ]; [[ "$output" == *'FAIL'* && "$output" == *'node'* ]]
  [ "$(wc -l < "$LOG" | tr -d ' ')" -eq 1 ]
  ! grep -q attestations "$LOG"
}

@test "unknown flag and missing explicit base return usage error" {
  run bash scripts/prepush.sh --wat
  [ "$status" -eq 2 ]
  unset PREPUSH_CHANGED_FILES_FILE
  run bash scripts/prepush.sh --base definitely-missing-ref
  [ "$status" -eq 2 ]
}

@test "cloud profile skips ios and names the CI job that covers it" {
  set_paths src/a.ts ios/Sources/A.swift
  run bash scripts/prepush.sh --profile cloud --list
  [ "$status" -eq 0 ]
  [[ "$output" == *'SKIPPED by --profile cloud: ios (needs macOS and Xcode; CI iOS Build and Swift Packages cover it)'* ]]
  [ "${lines[${#lines[@]}-1]}" = node ]
  run bash scripts/prepush.sh --profile cloud
  [ "$status" -eq 0 ]
  ! grep -q '^ios ' "$LOG"
  grep -q '^node --timing$' "$LOG"
  [[ "$output" == *'ios                SKIP  needs macOS and Xcode'* ]]
}

@test "cloud profile skips android without an SDK and runs it with one" {
  set_paths android/app/src/Main.kt
  printf '#!/usr/bin/env bash\n' > "$TEST_ROOT/bin/java"; chmod +x "$TEST_ROOT/bin/java"
  run env -u ANDROID_HOME -u ANDROID_SDK_ROOT -u JAVA_HOME bash scripts/prepush.sh --profile cloud
  [ "$status" -eq 0 ]
  [[ "$output" == *'SKIPPED by --profile cloud: android (no Android SDK'* ]]
  [[ "$output" == *'No pre-push gates selected'* ]]
  [ ! -f "$LOG" ]
  mkdir -p "$TEST_ROOT/sdk"
  run env -u ANDROID_SDK_ROOT -u JAVA_HOME ANDROID_HOME="$TEST_ROOT/sdk" bash scripts/prepush.sh --profile cloud --list
  [ "$status" -eq 0 ]; [ "$output" = android ]
}

@test "cloud profile skips android without java" {
  set_paths android/app/src/Main.kt
  mkdir -p "$TEST_ROOT/sdk" "$TEST_ROOT/nojava"
  for tool in bash env cat sed sort wc tr dirname basename date git; do
    if command -v "$tool" > /dev/null 2>&1; then ln -s "$(command -v "$tool")" "$TEST_ROOT/nojava/$tool"; fi
  done
  run env -u JAVA_HOME PATH="$TEST_ROOT/nojava" ANDROID_HOME="$TEST_ROOT/sdk" bash scripts/prepush.sh --profile cloud --list
  [ "$status" -eq 0 ]
  [[ "$output" == *'android (no java (JAVA_HOME or PATH)'* ]]
  # gradlew prefers JAVA_HOME, so a JDK there is enough even without java on PATH.
  mkdir -p "$TEST_ROOT/jdk/bin"
  printf '#!/usr/bin/env bash\n' > "$TEST_ROOT/jdk/bin/java"; chmod +x "$TEST_ROOT/jdk/bin/java"
  run env PATH="$TEST_ROOT/nojava" JAVA_HOME="$TEST_ROOT/jdk" ANDROID_HOME="$TEST_ROOT/sdk" bash scripts/prepush.sh --profile cloud --list
  [ "$status" -eq 0 ]; [ "$output" = android ]
  # A JAVA_HOME without a java binary fails gradlew, so it skips even with java on PATH.
  run env JAVA_HOME="$TEST_ROOT/sdk" ANDROID_HOME="$TEST_ROOT/sdk" bash scripts/prepush.sh --profile cloud --list
  [ "$status" -eq 0 ]
  [[ "$output" == *'android (no java (JAVA_HOME or PATH)'* ]]
}

@test "default profile runs every selected lane and node without --timing" {
  set_paths src/a.ts ios/Sources/A.swift
  run bash scripts/prepush.sh
  [ "$status" -eq 0 ]
  grep -q '^ios ' "$LOG"
  grep -q '^node $' "$LOG"
  [[ "$output" != *SKIP* ]]
}

@test "unknown profile is a usage error" {
  run bash scripts/prepush.sh --profile laptop --list
  [ "$status" -eq 2 ]; [[ "$output" == *'Unknown profile: laptop'* ]]
  run bash scripts/prepush.sh --profile
  [ "$status" -eq 2 ]
}

@test "timing forwards to node with changed, and only to node" {
  set_paths src/a.ts android/a.kt
  run bash scripts/prepush.sh --changed --timing
  [ "$status" -eq 0 ]
  grep -q '^node --changed --timing$' "$LOG"
  grep -q '^android --base-ref origin/main$' "$LOG"
}

@test "cloud profile with timing passes --timing once" {
  set_paths src/a.ts
  run bash scripts/prepush.sh --profile cloud --timing
  [ "$status" -eq 0 ]
  grep -q '^node --timing$' "$LOG"
}

@test "runner capability note is advisory and never fails the dispatcher" {
  set_paths android/control-proxy/src/WebSocketServer.kt
  mkdir -p scripts/release
  cat > scripts/release/runner-capability-note.sh <<'STUB'
#!/usr/bin/env bash
echo "note $*" >> "$LOG"
echo "runner-capability-note: NOTE (non-blocking)" >&2
exit 3
STUB
  run bash scripts/prepush.sh --base main
  [ "$status" -eq 0 ]
  grep -q '^note --base main$' "$LOG"
  grep -q '^android --base-ref main$' "$LOG"
  [[ "$output" == *"NOTE (non-blocking)"* ]]
  run bash scripts/prepush.sh --base main --list
  [ "$status" -eq 0 ]; [ "$output" = android ]
}

# Stubs the pin script through the bun shim: "unchanged" rewrites the manifest
# with identical bytes (an already-pinned tree), "changed" moves a pin (#18333).
stub_pin_script() {
  cat > "$TEST_ROOT/bin/bun" <<'STUB'
#!/usr/bin/env bash
echo "bun $*" >> "$LOG"
if [[ "$1" == scripts/release/pin-runtime-deps.ts && "$2" == --write ]]; then
  case "${PIN_STUB_MODE:-unchanged}" in
    unchanged) content="$(cat scripts/release/runtime-graph.json)"; printf '%s\n' "$content" > scripts/release/runtime-graph.json ;;
    changed) printf '{ "roots": ["a", "b"] }\n' > scripts/release/runtime-graph.json ;;
    fail) exit 1 ;;
  esac
fi
STUB
  chmod +x "$TEST_ROOT/bin/bun"
  mkdir -p "$TEST_ROOT/scripts/release"
  printf '{ "roots": ["a"] }\n' > "$TEST_ROOT/scripts/release/runtime-graph.json"
  printf '{}\n' > "$TEST_ROOT/package.json"
  printf 'lock\n' > "$TEST_ROOT/bun.lock"
  git -C "$TEST_ROOT" init -q
  git -C "$TEST_ROOT" add package.json bun.lock scripts/release/runtime-graph.json
  git -C "$TEST_ROOT" -c user.email=t@example.com -c user.name=t commit -q -m init
}

@test "runtime-pins lane leaves no working-tree diff when pins are current" {
  stub_pin_script
  set_paths bun.lock
  PIN_STUB_MODE=unchanged run bash scripts/prepush.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *"Runtime pins already current"* ]]
  [[ "$output" != *"Runtime pins changed"* ]]
  [ -z "$(git -C "$TEST_ROOT" status --porcelain -- package.json bun.lock scripts/release/runtime-graph.json)" ]
}

@test "runtime-pins lane reports changed pin outputs" {
  stub_pin_script
  set_paths bun.lock
  PIN_STUB_MODE=changed run bash scripts/prepush.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *"Runtime pins changed: commit"* ]]
  [ -n "$(git -C "$TEST_ROOT" status --porcelain -- scripts/release/runtime-graph.json)" ]
}

@test "runtime-pins lane failure stops before later lanes" {
  stub_pin_script
  set_paths bun.lock
  PIN_STUB_MODE=fail run bash scripts/prepush.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *"runtime-pins       FAIL"* ]]
  ! grep -q '^node ' "$LOG"
}
