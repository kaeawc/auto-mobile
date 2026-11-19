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

# Deliberate exceptions, each with its reason. Keys are `<workflow file>:<job id>`.
#   tvOS and watchOS smokes: no tvOS/watchOS 27.2 simulator runtime is installed on the
#   self-hosted Mac yet, so these stay on the newest toolchain that has them.
EXEMPT_JOBS="tvos-simulator-smoke.yml:tvos-smoke-advisory watchos-sim-smoke.yml:watchos-sim-smoke"

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
          if (step.uses === "maxim-lobanov/setup-xcode@v1") picks.push(step.with?.["xcode-version"]);
          const run = typeof step.run === "string" ? step.run : "";
          for (const m of run.matchAll(/select-self-hosted-xcode\.sh(?:\s+--\w+)*(?:\s+"([^"]+)"|\s+([^\s"]+))?/g)) picks.push(m[1] ?? m[2] ?? pin);
          if (step.uses === "./.github/actions/ios-simulator-bring-up") picks.push(step.with?.["xcode-version"]);
          for (const raw of picks) {
            const version = resolve(raw, config);
            if (version !== pin) bad.push(`${file}:${id}:${version}`);
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
