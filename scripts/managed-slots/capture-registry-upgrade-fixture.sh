#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 2 ]]; then
  echo "Usage: $0 [<git-ref>] [<out.sql>]" >&2
  exit 2
fi

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"
ref=${1:-beae9ed4286b64b7dbd71df9a91208c85c0b4e37}
out=${2:-test/fixtures/managed-slots/registry-schema-004.sql}
source_ref=$(git rev-parse --verify "${ref}^{commit}")
mkdir -p "$repo_root/scratch"
capture_root=$(mktemp -d "$repo_root/scratch/registry-upgrade-capture.XXXXXX")
trap 'rm -rf -- "$capture_root"' EXIT

git archive "$source_ref" src | tar -x -C "$capture_root"
if [[ -d "$repo_root/node_modules" ]]; then
  ln -s "$repo_root/node_modules" "$capture_root/node_modules"
fi

export AUTOMOBILE_DATA_DIR="$capture_root/data"
export AUTOMOBILE_LOG_DIR="$capture_root/log"
export AUTOMOBILE_APPEARANCE_SYNC=0
export CAPTURE_REGISTRY_REF="$source_ref"
# %q records a runnable Bash invocation even when arguments contain spaces or quotes.
printf -v CAPTURE_REGISTRY_COMMAND 'bash scripts/managed-slots/capture-registry-upgrade-fixture.sh %q %q' "$ref" "$out"
export CAPTURE_REGISTRY_COMMAND
bun "$repo_root/scripts/managed-slots/registry-upgrade-fixture-driver.ts" "$capture_root" "$out"
