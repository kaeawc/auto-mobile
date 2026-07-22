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
set +e
output="$(cd "${repo_root}" && bun run src/index.ts --boot-device --platform android \
  --name "${missing_avd}" --timeout-ms 5000 2>&1)"
set -e

if printf '%s' "${output}" | grep -q "Android emulator not found"; then
  echo "error: the product boot flow cannot resolve the Android emulator in CI." >&2
  printf '%s\n' "${output}" >&2
  exit 1
fi

echo "Android emulator SDK is resolvable by the product boot flow."
