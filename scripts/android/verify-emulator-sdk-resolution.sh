#!/usr/bin/env bash
# Main-push tripwire for the CI emulator SDK precondition (issue #4237).
#
# The emulator integration jobs are runner-heavy and only run nightly, so a
# break in the CI boot path can sit on main for a day looking green. This is the
# cheap half of that signal: it proves the *product* boot flow can resolve the
# emulator binary in a CI environment, without booting anything.
#
# It deliberately asks for an AVD that does not exist. A healthy environment
# fails with "no matching device"; a broken one fails with "Android emulator not
# found", which is the regression this guards.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"

"${script_dir}/ensure-emulator-sdk.sh"

missing_avd="automobile-sdk-resolution-probe"

# The one outcome that proves the SDK resolved: the product enumerated the AVDs,
# found none matching, and refused to create one. This substring is the
# ActionableError text in src/utils/deviceBootService.ts (provisionAndBoot); a
# BATS guard pins the two together so a product reword is caught in-repo instead
# of turning main red.
expected_diagnostic="device matching criteria found"
# The regression this tripwire exists for (issue #4237).
resolution_failure="Android emulator not found"

set +e
# Pin creation off explicitly. This probe deliberately names an AVD that does
# not exist, so if AUTOMOBILE_ALLOW_DEVICE_CREATE is ever turned on repo-wide it
# would turn a two-minute resolution check into a full emulator provision.
output="$(cd "${repo_root}" && AUTOMOBILE_ALLOW_DEVICE_CREATE=0 \
  bun run src/index.ts --boot-device --platform android \
  --name "${missing_avd}" --timeout-ms 5000 2>&1)"
probe_status=$?
set -e

if printf '%s\n' "${output}" | grep -q "${resolution_failure}"; then
  echo "error: the product boot flow cannot resolve the Android emulator in CI." >&2
  printf '%s\n' "${output}" >&2
  exit 1
fi

# Fail closed from here on. Everything below is an outcome this guard does not
# understand, and a guard that cannot tell "healthy" from "unknown" is the exact
# blind spot issue #4237 was about.
if [ "${probe_status}" -eq 0 ]; then
  echo "error: the emulator SDK resolution probe unexpectedly succeeded." >&2
  echo "It asks for AVD '${missing_avd}', which must not exist; a success means the probe is no longer testing resolution." >&2
  printf '%s\n' "${output}" >&2
  exit 1
fi

if ! printf '%s\n' "${output}" | grep -q "${expected_diagnostic}"; then
  echo "error: the emulator SDK resolution probe failed for an unexpected reason (exit ${probe_status})." >&2
  echo "Expected the boot flow to fail with \"${expected_diagnostic}\"; it did not, so the SDK precondition is unverified." >&2
  printf '%s\n' "${output}" >&2
  exit 1
fi

echo "Android emulator SDK is resolvable by the product boot flow."
