#!/usr/bin/env bats
# bats file_tags=parallel-within-file
# scripts/ios/swift-build-prototype-apps.sh and its PR matrix job (#18429). The script runs
# from a temp copy of scripts/ios beside stub build scripts and a stub xcrun, so no Xcode is needed.

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
PR_WORKFLOW="${REPO_ROOT}/.github/workflows/pull_request.yml"

setup() {
  SANDBOX="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$SANDBOX/scripts/ios" "$BATS_TEST_TMPDIR/bin"
  cp "$REPO_ROOT/scripts/ios/swift-build-prototype-apps.sh" "$SANDBOX/scripts/ios/"
  CALLS="$BATS_TEST_TMPDIR/calls"
  export CALLS
  local name
  for name in prototype-agent-build.sh prototype-viewer-build.sh protoviewer-build.sh; do
    cat > "$SANDBOX/scripts/ios/$name" <<STUB
#!/usr/bin/env bash
echo "$name \$*" >> "\$CALLS"
[[ "\${FAIL_BUILD:-}" != "$name" ]]
STUB
    chmod +x "$SANDBOX/scripts/ios/$name"
  done
  cat > "$BATS_TEST_TMPDIR/bin/xcrun" <<'STUB'
#!/usr/bin/env bash
[[ "${NO_SIM_SDK:-}" != 1 ]]
STUB
  chmod +x "$BATS_TEST_TMPDIR/bin/xcrun"
  SCRIPT="$SANDBOX/scripts/ios/swift-build-prototype-apps.sh"
}

run_script() {
  run env PATH="$BATS_TEST_TMPDIR/bin:$PATH" "$@"
}

# Parse the PR workflow and print the JavaScript expression $1, evaluated with the parsed
# document bound to `wf`. Strings print raw, other values as JSON.
wf_query() {
  (cd "$REPO_ROOT" && bun -e '
    import { load } from "js-yaml";
    const wf = load(await Bun.file(process.argv[1]).text());
    const v = new Function("wf", `return (${process.argv[2]});`)(wf);
    process.stdout.write(v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));
  ' "$PR_WORKFLOW" "$1")
}

@test "all builds every prototype app in order into scratch/<app>-ci" {
  run_script bash "$SCRIPT"
  [ "$status" -eq 0 ]
  run cat "$CALLS"
  [ "${lines[0]}" = "prototype-agent-build.sh $SANDBOX/scratch/prototype-agent-ci" ]
  [ "${lines[1]}" = "prototype-viewer-build.sh $SANDBOX/scratch/prototype-viewer-ci" ]
  [ "${lines[2]}" = "protoviewer-build.sh $SANDBOX/scratch/protoviewer-ci" ]
  [ "${#lines[@]}" -eq 3 ]
}

@test "one app name builds only that app" {
  run_script bash "$SCRIPT" protoviewer
  [ "$status" -eq 0 ]
  [ "$(cat "$CALLS")" = "protoviewer-build.sh $SANDBOX/scratch/protoviewer-ci" ]
}

@test "a failed build fails the run after the remaining apps still build" {
  run_script env FAIL_BUILD=prototype-viewer-build.sh bash "$SCRIPT" all
  [ "$status" -eq 1 ]
  [[ "$output" == *"Failed prototype apps: prototype-viewer"* ]]
  [ "$(wc -l < "$CALLS" | tr -d ' ')" -eq 3 ]
}

@test "an unknown app name is a usage error and builds nothing" {
  run_script bash "$SCRIPT" prototype-agnet
  [ "$status" -eq 2 ]
  [[ "$output" == *"Unknown prototype app: prototype-agnet"* ]]
  [ ! -e "$CALLS" ]
}

@test "no iphonesimulator SDK skips without failing" {
  run_script env NO_SIM_SDK=1 bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Skipping prototype apps (no iphonesimulator SDK)"* ]]
  [ ! -e "$CALLS" ]
}

@test "swift-build.sh builds the prototype apps unless SWIFT_BUILD_PROTOTYPE_APPS=skip" {
  grep -q 'SWIFT_BUILD_PROTOTYPE_APPS:-all}" == "skip"' "$REPO_ROOT/scripts/ios/swift-build.sh"
  grep -q 'swift-build-prototype-apps.sh" all' "$REPO_ROOT/scripts/ios/swift-build.sh"
}

@test "the PR packages job skips the prototype apps that the prototype matrix builds" {
  run wf_query 'wf.jobs["ios-swift-packages"].steps.find((s) => s.name === "Build Swift Packages").env.SWIFT_BUILD_PROTOTYPE_APPS'
  [ "$status" -eq 0 ]
  [ "$output" = "skip" ]
  # Every app the script knows is a matrix leg, so skipping them loses no coverage.
  run wf_query 'wf.jobs["ios-swift-prototype-apps"].strategy.matrix.config.map((c) => c.app).join(" ")'
  [ "$status" -eq 0 ]
  [ "$output" = "prototype-agent prototype-viewer protoviewer" ]
  grep -q '^ALL_APPS=(prototype-agent prototype-viewer protoviewer)$' "$REPO_ROOT/scripts/ios/swift-build-prototype-apps.sh"
  run wf_query 'wf.jobs["ios-swift-prototype-apps"].steps.find((s) => s.name === "Build ${{ matrix.config.app }}").run'
  [ "$output" = './scripts/ios/swift-build-prototype-apps.sh "${{ matrix.config.app }}"' ]
}

@test "both Swift jobs keep a bounded timeout under the old 45 minute limit" {
  run wf_query '[wf.jobs["ios-swift-packages"]["timeout-minutes"], wf.jobs["ios-swift-prototype-apps"]["timeout-minutes"]].join(" ")'
  [ "$status" -eq 0 ]
  [ "$output" = "30 30" ]
}

@test "the prototype matrix runs under the same gate as the packages job" {
  run wf_query 'wf.jobs["ios-swift-prototype-apps"].if === wf.jobs["ios-swift-packages"].if && wf.jobs["ios-swift-prototype-apps"]["runs-on"] === wf.jobs["ios-swift-packages"]["runs-on"]'
  [ "$output" = "true" ]
}
