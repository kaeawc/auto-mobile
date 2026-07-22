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
# found none matching, and refused to create one. These substrings come from the
# ActionableError in src/utils/deviceBootService.ts (provisionAndBoot), which
# interpolates the platform and the requested name:
#   `No ${platform} device matching criteria found. ... name=${name} ...`
# A BATS guard pins them to the product text so a reword is caught in-repo
# instead of turning main red.
#
# Both halves are required, and specifically the ANDROID one. Matching only the
# platform-agnostic "device matching criteria found" also matches the iOS
# diagnostic ("No ios device matching criteria found"), so a boot-device CLI that
# regressed to ignore --platform android, or that routed through the iOS manager,
# would report a healthy *Android* SDK without exercising Android at all — the
# same fail-open this tripwire exists to prevent.
expected_diagnostic="No android device matching criteria found"
# Pins the failure to *our* probe rather than any incidental no-match message.
expected_probe_name="name=${missing_avd}"
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

# Match with case, not `printf | grep -q`: grep -q exits on the first match, the
# printf ahead of it can then take SIGPIPE, and `set -o pipefail` would turn a
# healthy probe with plenty of trailing output into a pipeline failure.
case "${output}" in
  *"${resolution_failure}"*)
    echo "error: the product boot flow cannot resolve the Android emulator in CI." >&2
    printf '%s\n' "${output}" >&2
    exit 1
    ;;
esac

# Fail closed from here on. Everything below is an outcome this guard does not
# understand, and a guard that cannot tell "healthy" from "unknown" is the exact
# blind spot issue #4237 was about.
if [ "${probe_status}" -eq 0 ]; then
  echo "error: the emulator SDK resolution probe unexpectedly succeeded." >&2
  echo "It asks for AVD '${missing_avd}', which must not exist; a success means the probe is no longer testing resolution." >&2
  printf '%s\n' "${output}" >&2
  exit 1
fi

case "${output}" in
  *"${expected_diagnostic}"*) ;;
  *)
    echo "error: the emulator SDK resolution probe failed for an unexpected reason (exit ${probe_status})." >&2
    echo "Expected the boot flow to fail with \"${expected_diagnostic}\"; it did not, so the SDK precondition is unverified." >&2
    echo "Note a platform-agnostic no-match message is NOT enough here: the iOS path emits the same wording, and this guard must prove the *Android* SDK resolved." >&2
    printf '%s\n' "${output}" >&2
    exit 1
    ;;
esac

case "${output}" in
  *"${expected_probe_name}"*) ;;
  *)
    echo "error: the boot flow reported no matching Android device, but not for the AVD this probe asked for (exit ${probe_status})." >&2
    echo "Expected \"${expected_probe_name}\" in the diagnostic; without it the failure may come from some other lookup, so the SDK precondition is unverified." >&2
    printf '%s\n' "${output}" >&2
    exit 1
    ;;
esac

echo "Android emulator SDK is resolvable by the product boot flow."
