#!/usr/bin/env bash
#
# Regenerate today's release-download snapshot on top of the latest origin/main
# and push the result, retrying if a concurrent push wins the race first.
#
# Why re-sync + regenerate instead of rebase-and-push:
#   The old inline loop did `git pull --rebase origin main && git push`. When a
#   concurrent push had already advanced main, the rebase hit a conflict on the
#   shared docs/metrics/data/downloads.jsonl and left the tree with unmerged
#   files. The next iteration then failed with "Pulling is not possible because
#   you have unmerged files" — the failure cascaded instead of retrying cleanly
#   (issue #3590, same class as scripts/push-readme-badges.sh).
#
#   This script is conflict-free by construction: each attempt hard-resets to the
#   latest origin/main and regenerates the snapshot from scratch, so there is
#   never anything to merge or rebase. CI also serializes this job with a
#   concurrency group, but main can still advance between reset and push (a
#   non-metrics push), which the retry loop absorbs.
set -euo pipefail

attempts="${SNAPSHOT_PUSH_ATTEMPTS:-5}"
retry_sleep="${SNAPSHOT_RETRY_SLEEP:-5}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
collector="${SNAPSHOT_COLLECTOR:-${script_dir}/collect-release-downloads.ts}"
data_file="docs/metrics/data/downloads.jsonl"

for attempt in $(seq 1 "${attempts}"); do
  git fetch origin main
  git reset --hard origin/main

  # Regenerate on top of the freshly-reset main so the snapshot always reflects
  # the latest committed history — never a stale pre-reset tree.
  bun "${collector}"

  if git diff --quiet -- "${data_file}"; then
    echo "Download snapshot already up to date with origin/main"
    exit 0
  fi

  git add "${data_file}"
  # "[skip ci]" stops this machine commit from re-triggering push CI.
  git commit -m "chore(metrics): daily release download snapshot [skip ci]"

  if git push origin HEAD:main; then
    echo "Pushed download snapshot to main"
    exit 0
  fi

  echo "Push attempt ${attempt} lost a race with origin/main; retrying..." >&2
  sleep "${retry_sleep}"
done

echo "Failed to push download snapshot to main after ${attempts} attempts" >&2
exit 1
