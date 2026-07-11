#!/usr/bin/env bash
#
# Regenerate the README test-count badges on top of the latest origin/main and
# push the result, retrying if a concurrent push wins the race first.
#
# Why re-sync + regenerate instead of rebase-and-push:
#   The old inline loop did `git pull --rebase origin main && git push`. When a
#   concurrent merge had already pushed its own badge commit, the rebase hit a
#   conflict on the same README badge region and left the tree with unmerged
#   files. The next loop iteration then failed with "Pulling is not possible
#   because you have unmerged files" — the failure cascaded instead of retrying
#   cleanly (issue #3590).
#
#   This script is conflict-free by construction: each attempt hard-resets to the
#   latest origin/main and regenerates the badge from scratch, so there is never
#   anything to merge or rebase. CI also serializes this job with a concurrency
#   group, but main can still advance between reset and push (a non-badge push),
#   which the retry loop absorbs.
set -euo pipefail

attempts="${BADGE_PUSH_ATTEMPTS:-3}"
retry_sleep="${BADGE_RETRY_SLEEP:-5}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
update_script="${BADGE_UPDATE_SCRIPT:-${script_dir}/update-readme-badges.sh}"

for attempt in $(seq 1 "${attempts}"); do
  git fetch origin main
  git reset --hard origin/main

  bash "${update_script}"

  if git diff --quiet README.md; then
    echo "Badge counts already up to date with origin/main"
    exit 0
  fi

  git add README.md
  # "[skip ci]" stops this cosmetic commit from re-triggering the merge workflow
  # (and any other push-triggered CI).
  git commit -m "chore: update README test count badges [skip ci]"

  if git push origin HEAD:main; then
    echo "Pushed badge update to main"
    exit 0
  fi

  echo "Push attempt ${attempt} lost a race with origin/main; retrying..." >&2
  sleep "${retry_sleep}"
done

echo "Failed to push badge update to main after ${attempts} attempts" >&2
exit 1
