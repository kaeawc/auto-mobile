#!/usr/bin/env bash
# Build the published prototype library and a local-path embedding consumer, without booting a simulator.
# Usage: scripts/ios/prototype-library-build.sh [output-dir] (default scratch/prototype-library)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/lib/spotlight-exclude.sh
source "${repo_root}/scripts/lib/spotlight-exclude.sh"
out_dir="${1:-${repo_root}/scratch/prototype-library}"
mkdir_spotlight_excluded_within "${repo_root}" "${out_dir}"
out_dir="$(cd "${out_dir}" && pwd)"

# shellcheck source=scripts/ios/local-sim-build-args.sh
source "${repo_root}/scripts/ios/local-sim-build-args.sh"
extra_args=()
while IFS= read -r arg; do
  [[ -n "${arg}" ]] && extra_args+=("${arg}")
done < <(local_sim_build_args)

cd "${repo_root}"
xcodebuild build -scheme AutoMobilePrototype -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "${out_dir}/library" \
  ${extra_args[@]+"${extra_args[@]}"}

cd "${repo_root}/ios/prototype-agent/Fixtures/EmbedConsumer"
xcodebuild build -scheme EmbedConsumer -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "${out_dir}/consumer" \
  ${extra_args[@]+"${extra_args[@]}"}
