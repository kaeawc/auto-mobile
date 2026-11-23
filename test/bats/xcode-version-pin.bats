#!/usr/bin/env bats
# Guards the single Xcode pin, AUTOMOBILE_XCODE_VERSION in scripts/ios/xcode_version.sh:
# every GitHub Actions job that selects an Xcode (setup-xcode or select-self-hosted-xcode.sh)
# selects the pinned version, the CircleCI executor defaults to it, and the local helper
# exports DEVELOPER_DIR for it without touching the machine-wide xcode-select default.
# Workflows read through js-yaml, so a commented-out line cannot satisfy the guard.

setup() {
  repo_root="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  cd "${repo_root}"
  # shellcheck source=scripts/ios/xcode_version.sh
  source scripts/ios/xcode_version.sh
  pin="${AUTOMOBILE_XCODE_VERSION}"
}

# Deliberate exceptions, each with its reason. Keys are `<workflow file>:<job id>` (the whole
# job) or `<workflow file>:<job id>:<version>` (one matrix entry).
#   ios-spm-root-package-build 26.6: the root manifest's published Swift 6.3 floor entry,
#   built next to the pinned 27.2 entry (#18816).
EXEMPT_JOBS="pull_request.yml:ios-spm-root-package-build:26.6"

# Print `<file>:<job>:<version>` for each Xcode selection in workflow file $1 that is not
# the pin, resolving matrix.config.xcode and env.XCODE_VERSION references.
off_pin() {
  bun -e '
    import { load } from "js-yaml";
    const [path, pin, exempt] = process.argv.slice(1);
    const file = path.split("/").pop();
    const wf = load(await Bun.file(path).text());
    const exempted = new Set(exempt.split(" "));
    const bad = [];
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      if (exempted.has(`${file}:${id}`)) continue;
      const configs = job.strategy?.matrix?.config ?? [{}];
      const resolve = (raw, config) =>
        String(raw)
          .replace(/\$\{\{\s*matrix\.config\.xcode\s*\}\}/g, config.xcode ?? "")
          .replace(/\$\{\{\s*env\.XCODE_VERSION\s*\}\}/g, job.env?.XCODE_VERSION ?? wf.env?.XCODE_VERSION ?? "");
      for (const config of configs) {
        for (const step of job.steps ?? []) {
          const picks = [];
          if (step.uses?.split("@")[0] === "maxim-lobanov/setup-xcode") picks.push(step.with?.["xcode-version"]);
          const run = typeof step.run === "string" ? step.run : "";
          for (const m of run.matchAll(/select-self-hosted-xcode\.sh(?:\s+--[\w-]+)*(?:\s+"([^"]+)"|\s+(?!--)([^\s"]+))?/g)) picks.push(m[1] ?? m[2] ?? pin);
          if (step.uses === "./.github/actions/ios-simulator-bring-up") picks.push(step.with?.["xcode-version"]);
          for (const raw of picks) {
            const version = resolve(raw, config);
            if (version !== pin && !exempted.has(`${file}:${id}:${version}`)) bad.push(`${file}:${id}:${version}`);
          }
        }
      }
    }
    process.stdout.write(bad.join("\n"));
  ' "$1" "${pin}" "${EXEMPT_JOBS}"
}

@test "the pin is a plain version" {
  [[ "${pin}" =~ ^[0-9]+\.[0-9]+$ ]]
}

@test "every workflow job that selects an Xcode selects the pin" {
  local offenders=""
  for wf in .github/workflows/*.yml; do
    run off_pin "${wf}"
    [ "${status}" -eq 0 ]
    [[ -z "${output}" ]] || offenders+="${output}"$'\n'
  done
  if [[ -n "${offenders}" ]]; then
    echo "Jobs not on pinned Xcode ${pin}:" >&2
    echo "${offenders}" >&2
    return 1
  fi
}

@test "the guard flags a job left on another Xcode" {
  local wf="${BATS_TEST_TMPDIR}/fake.yml"
  cat > "${wf}" << 'YAML'
jobs:
  build:
    strategy:
      matrix:
        config:
          - { name: "Xcode 26.6", xcode: "26.6" }
    steps:
      - uses: maxim-lobanov/setup-xcode@v1
        with:
          xcode-version: ${{ matrix.config.xcode }}
      - run: bash scripts/ci/select-self-hosted-xcode.sh "26.5"
YAML
  run off_pin "${wf}"
  [ "${status}" -eq 0 ]
  [ "${output}" = $'fake.yml:build:26.6\nfake.yml:build:26.5' ]
}

@test "the CircleCI ios executor defaults to the pin" {
  run bun -e '
    import { load } from "js-yaml";
    const c = load(await Bun.file(".circleci/continue_config.yml").text());
    process.stdout.write(String(c.executors.ios.parameters.xcode.default));
  '
  [ "${status}" -eq 0 ]
  [ "${output}" = "${pin}" ]
}

@test "select_pinned_xcode keeps a DEVELOPER_DIR the caller already set" {
  run bash -c 'export DEVELOPER_DIR=/chosen; source scripts/ios/xcode_version.sh; select_pinned_xcode; printf %s "${DEVELOPER_DIR}"'
  [ "${status}" -eq 0 ]
  [ "${output}" = "/chosen" ]
}

# Fake xcode-select and plutil: the active Xcode is $1, and the pinned one is installed
# under a fake Applications dir unless $2 is "missing".
fake_toolchain() {
  local apps="${BATS_TEST_TMPDIR}/Applications" bin="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "${apps}/Xcode.app/Contents/Developer" "${bin}"
  printf '%s' "$1" > "${apps}/Xcode.app/Contents/version.plist"
  if [[ "${2:-}" != missing ]]; then
    mkdir -p "${apps}/Xcode-${pin}.0.app/Contents/Developer"
    printf '%s' "${pin}" > "${apps}/Xcode-${pin}.0.app/Contents/version.plist"
  fi
  printf '#!/usr/bin/env bash\necho %q\n' "${apps}/Xcode.app/Contents/Developer" > "${bin}/xcode-select"
  printf '#!/usr/bin/env bash\ncat "${@: -1}"\n' > "${bin}/plutil"
  chmod +x "${bin}/xcode-select" "${bin}/plutil"
  export PATH="${bin}:${PATH}" XCODE_APPLICATIONS_DIR="${apps}"
}

@test "select_pinned_xcode exports the installed pinned Xcode when another one is active" {
  fake_toolchain 26.6
  run bash -c 'unset DEVELOPER_DIR; source scripts/ios/xcode_version.sh; select_pinned_xcode 2>/dev/null; printf %s "${DEVELOPER_DIR}"'
  [ "${status}" -eq 0 ]
  [ "${output}" = "${XCODE_APPLICATIONS_DIR}/Xcode-${pin}.0.app/Contents/Developer" ]
}

@test "select_pinned_xcode leaves DEVELOPER_DIR unset when the active Xcode is the pin" {
  fake_toolchain "${pin}" missing
  run bash -c 'unset DEVELOPER_DIR; source scripts/ios/xcode_version.sh; select_pinned_xcode; printf "[%s]" "${DEVELOPER_DIR:-}"'
  [ "${status}" -eq 0 ]
  [ "${output}" = "[]" ]
}

@test "select_pinned_xcode keeps the active Xcode and says so when the pin is not installed" {
  fake_toolchain 26.6 missing
  run bash -c 'unset DEVELOPER_DIR; source scripts/ios/xcode_version.sh; select_pinned_xcode; printf "[%s]" "${DEVELOPER_DIR:-}"'
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"Pinned Xcode ${pin} is not installed; using the active Xcode 26.6."* ]]
  [[ "${output}" == *"[]" ]]
}

# Scripts that run xcodebuild, xcrun or swift without selecting the pin, each with its reason.
# Every other such script under scripts/ must call select_pinned_xcode (or the CI selector),
# so a host whose xcode-select names an older Xcode still builds on the pin.
EXEMPT_SCRIPTS=(
  # Text scans and lint over other scripts; they run no Xcode tool.
  scripts/all_fast_validate_checks.sh
  scripts/check-no-new-direct-xcodebuild.sh
  scripts/ios/xctestrunner_test_filter.sh
  # End-user installer: reports the user's own Xcode and runtimes.
  scripts/install.sh
  # Release builders and signers: their workflows select the pin with setup-xcode first.
  scripts/ci/notarize-macos-artifact.sh
  scripts/ios/build-audio-loopback-helper-release.sh
  scripts/ios/build-network-filter-probe.sh
  scripts/ios/build-screen-capture-helper-release.sh
  scripts/ios/build-simulator-runner-release.sh
  scripts/ios/build-tvos-runner-release.sh
  scripts/ios/ctrl-proxy-create-ipa.sh
  scripts/ios/sign-ios-frameworks.sh
  scripts/ios/sign-macos-products.sh
  scripts/release/capture-protoviewer-policy-fixtures.sh
  # Helpers only called by build scripts that already selected the pin.
  scripts/ios/patch-ctrl-proxy-ui-test-runner-icon.sh
  scripts/ios/prototype-effects-metallib.sh
  # simctl on simulators that already exist; no build and no SDK lookup.
  scripts/ios/ctrl-proxy-uninstall.sh
  scripts/ios/kill-all-simulators.sh
  scripts/ios/navigation-graph-sdk-event-integration.sh
  scripts/ios/prototype-record-goldens.sh
  scripts/ios/saved-prototype-smoke.sh
  scripts/ios/shutdown-main-simulator.sh
  # Sources scripts/local-dev/lib/ctrl-proxy-ios.sh, which selects the pin.
  scripts/local-dev/hot-reload.sh
  # Builds SwiftFormat itself with whatever Swift is installed.
  scripts/swiftformat/install_swiftformat.sh
)

@test "every script that runs an Xcode tool selects the pin or has a stated exemption" {
  local offenders="" f exempt
  while IFS= read -r f; do
    grep -v -E '^[[:space:]]*#' "${f}" \
      | grep -q -E '(^|[^A-Za-z_-])(xcodebuild|xcrun|swift (build|test|package))([^A-Za-z_-]|$)' || continue
    grep -q -E 'select_pinned_xcode|select-self-hosted-xcode' "${f}" && continue
    exempt=false
    for e in "${EXEMPT_SCRIPTS[@]}"; do [[ "${f}" == "${e}" ]] && exempt=true; done
    [[ "${exempt}" == true ]] || offenders+="${f}"$'\n'
  done < <(git ls-files 'scripts/*.sh')
  if [[ -n "${offenders}" ]]; then
    echo "Scripts running Xcode tools without select_pinned_xcode:" >&2
    echo "${offenders}" >&2
    return 1
  fi
}

@test "every exempt script still exists" {
  for e in "${EXEMPT_SCRIPTS[@]}"; do
    [[ -f "${e}" ]] || { echo "stale exemption: ${e}" >&2; return 1; }
  done
}
