#!/usr/bin/env bats
# Wiring guard: the build-* artifact workflows build on the hosted xcode-27 image with Xcode 27.2
# selected explicitly, since the image default is 27.1 (#18374). Assertions read each workflow
# through js-yaml, so a commented-out line cannot satisfy them.

ARTIFACT_WORKFLOWS=(
  build-ctrl-proxy-ios-ipa
  build-tvos-runner
  build-watchos-runner
  build-visionos-runner
  build-prototype-agent
  build-prototype-viewer
  build-screen-capture-helper
  build-audio-loopback-helper
  build-network-filter-probe
)

# Print `<workflow>:<job>` for each job of workflow file $1 that does not run on xcode-27 or does
# not select Xcode 27.2 through setup-xcode.
off_xcode_27_2() {
  bun -e '
    import { load } from "js-yaml";
    const path = process.argv[1];
    const wf = load(await Bun.file(path).text());
    const bad = Object.entries(wf.jobs).filter(([, j]) => {
      const setup = (j.steps ?? []).filter((s) => s.uses === "maxim-lobanov/setup-xcode@v1");
      return j["runs-on"] !== "xcode-27" || setup.length !== 1 || setup[0].with?.["xcode-version"] !== "27.2";
    });
    process.stdout.write(bad.map(([id]) => `${path}:${id}`).join("\n"));
  ' "$1"
}

@test "every artifact workflow job runs on xcode-27 and selects Xcode 27.2" {
  for name in "${ARTIFACT_WORKFLOWS[@]}"; do
    run off_xcode_27_2 ".github/workflows/${name}.yml"
    [ "${status}" -eq 0 ]
    [ "${output}" = "" ]
  done
}

@test "the guard flags a job left on macos-26 with Xcode 26.6" {
  fixture="${BATS_TEST_TMPDIR}/stale.yml"
  cat >"${fixture}" <<'YAML'
jobs:
  build:
    runs-on: macos-26
    steps:
      - uses: maxim-lobanov/setup-xcode@v1
        with:
          xcode-version: "26.6"
YAML
  run off_xcode_27_2 "${fixture}"
  [ "${status}" -eq 0 ]
  [ "${output}" = "${fixture}:build" ]
}
