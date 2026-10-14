#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ios/run_with_timeout.sh disable=SC1091
source "${script_dir}/run_with_timeout.sh"
device_id="${1:-}"
if [[ -z "$device_id" ]]; then echo 'usage: saved-prototype-smoke-advisory.sh <simulator-udid>' >&2; exit 0; fi
smoke_cmd="${SAVED_PROTOTYPE_SMOKE_CMD:-${script_dir}/saved-prototype-smoke.sh}"
reset_cmd="${SAVED_PROTOTYPE_SMOKE_RESET_CMD:-${script_dir}/../android/reset-daemon-before-retry.sh}"
if ! "$reset_cmd"; then echo '::warning title=Saved prototype smoke::daemon reset failed (advisory)'; fi
status=0
set +e
run_with_timeout "${SAVED_PROTOTYPE_SMOKE_TIMEOUT_SECONDS:-600}" env -u AUTOMOBILE_ENABLED_TOOLS "$smoke_cmd" "$device_id"
status=$?
set -e
echo "Saved prototype smoke exit status: ${status} (advisory; does not fail the job)"
if [[ "$status" -ne 0 ]]; then
  if [[ "$status" -eq 124 ]]; then echo '::warning title=Saved prototype smoke::saved prototype smoke timed out (advisory)'
  else echo '::warning title=Saved prototype smoke::saved prototype smoke failed (advisory)'; fi
fi
exit 0
