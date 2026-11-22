#!/usr/bin/env bats
# Wiring guard for the advisory Xcode 27.2 runner-build workflow on the hosted xcode-27 image
# (#18363, trimmed to the runner builds in #18816).
# Assertions read the workflow through js-yaml, so a commented-out line cannot satisfy them.

WORKFLOW=".github/workflows/ios-xcode-27-2.yml"
PR_WORKFLOW=".github/workflows/pull_request.yml"

# Parse workflow file $1 and print the JavaScript expression $2, evaluated with the parsed
# document bound to `wf`. Strings print raw, other values as JSON.
wf_query() {
  bun -e '
    import { load } from "js-yaml";
    const wf = load(await Bun.file(process.argv[1]).text());
    const v = new Function("wf", `return (${process.argv[2]});`)(wf);
    process.stdout.write(v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));
  ' "$1" "$2"
}

@test "every job runs on the hosted xcode-27 image" {
  run wf_query "${WORKFLOW}" '[...new Set(Object.values(wf.jobs).map((j) => j["runs-on"]))].join(",")'
  [ "${status}" -eq 0 ]
  [ "${output}" = "xcode-27" ]
}

@test "every job selects Xcode 27.2 explicitly and verifies it before building" {
  [ "$(wf_query "${WORKFLOW}" 'wf.env.XCODE_VERSION')" = "27.2" ]
  run wf_query "${WORKFLOW}" 'Object.entries(wf.jobs).filter(([, j]) => {
    const i = j.steps.findIndex((s) => s.uses?.split("@")[0] === "maxim-lobanov/setup-xcode");
    const v = j.steps[i + 1];
    return !(i >= 0 && j.steps[i].with["xcode-version"] === "${{ env.XCODE_VERSION }}" &&
      v?.name === "Verify Xcode 27.2 is active" && v.run.includes("xcodebuild -version") && v.run.includes("exit 1"));
  }).map(([id]) => id).join(",")'
  [ "${status}" -eq 0 ]
  [ "${output}" = "" ]
}

@test "the lane builds only the tvOS/watchOS/visionOS runners the required jobs do not" {
  [ "$(wf_query "${WORKFLOW}" 'Object.keys(wf.jobs).join(",")')" = "simulator-runners" ]
  runs="$(wf_query "${WORKFLOW}" 'Object.values(wf.jobs).flatMap((j) => j.steps.map((s) => s.run ?? "")).join("\n")')"
  [[ "${runs}" == *"scripts/ios/build-tvos-runner-release.sh"* ]]
  [[ "${runs}" == *"scripts/ios/build-simulator-runner-release.sh --platform"* ]]
  [ "$(wf_query "${WORKFLOW}" 'wf.jobs["simulator-runners"].strategy.matrix.platform.map((p) => p.id).join(",")')" = "tvos,watchos,visionos" ]
}

@test "the lane builds unsigned and uploads nothing" {
  run grep -nE 'secrets\.|upload-artifact' "${WORKFLOW}"
  [ "${status}" -eq 1 ]
}

@test "job names say Xcode 27.2 and Advisory" {
  run wf_query "${WORKFLOW}" 'Object.values(wf.jobs).filter((j) => !j.name.endsWith("(Xcode 27.2, Advisory)")).length'
  [ "${output}" = "0" ]
}

@test "the required iOS jobs use the same pinned Xcode and do not reference this workflow" {
  source scripts/ios/xcode_version.sh
  for job in ios-swift-packages ios-xcode-build; do
    run wf_query "${PR_WORKFLOW}" "wf.jobs[\"${job}\"].strategy.matrix.config.map((c) => c.xcode).join(\",\")"
    [ "${output}" = "${AUTOMOBILE_XCODE_VERSION}" ]
  done
  run grep -nE 'ios-xcode-27-2' "${PR_WORKFLOW}"
  [ "${status}" -eq 1 ]
}
