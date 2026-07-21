#!/usr/bin/env bash
#
# Regenerate the release constants on top of the latest origin/main and push the
# result straight to main, retrying if a concurrent push wins the race first.
#
# Why direct-to-main instead of a PR:
#   The nightly checksum update used to open a PR and enable auto-merge. That
#   burned an external code review on a machine-generated one-line constant bump,
#   and the PR could wedge: opening the PR with labels fired several
#   `pull_request` events in the same second, and when `cancel-in-progress`
#   cancelled the run that had already registered its check runs, those cancelled
#   checks stayed pinned to the head SHA and the green-main ruleset never saw the
#   required contexts satisfied. Auto-merge then parked forever (PR #4090).
#
#   AUTO_MOBILE_PR_TOKEN is an admin actor and bypasses the green-main ruleset,
#   so the push lands with no PR and no status checks — the same mechanism
#   push-readme-badges.sh already uses for the README badge commit.
#
# Why re-sync + regenerate instead of rebase-and-push:
#   Each attempt hard-resets to the latest origin/main and regenerates the
#   constants from scratch, so there is never anything to merge or rebase and a
#   concurrent push can never leave a conflicted tree (the failure mode that
#   issue #3590 fixed for the badge push).
set -euo pipefail

attempts="${RELEASE_CONSTANTS_PUSH_ATTEMPTS:-3}"
retry_sleep="${RELEASE_CONSTANTS_RETRY_SLEEP:-5}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
generate_script="${RELEASE_CONSTANTS_GENERATE_SCRIPT:-${script_dir}/generate-release-constants.sh}"

if [ -z "${RELEASE_CONSTANTS_COMMIT_MESSAGE:-}" ]; then
  echo "RELEASE_CONSTANTS_COMMIT_MESSAGE must be set" >&2
  exit 1
fi

for attempt in $(seq 1 "${attempts}"); do
  git fetch origin main
  git reset --hard origin/main

  bash "${generate_script}"

  if git diff --quiet; then
    echo "Release constants already up to date with origin/main"
    exit 0
  fi

  # Stage tracked modifications only. The job's working tree also holds the
  # downloaded APK/IPA/jar artifacts, which `git add -A` would sweep in.
  git add -u
  git commit -m "${RELEASE_CONSTANTS_COMMIT_MESSAGE}"

  if git push origin HEAD:main; then
    echo "Pushed release constants update to main"
    exit 0
  fi

  echo "Push attempt ${attempt} lost a race with origin/main; retrying..." >&2
  sleep "${retry_sleep}"
done

echo "Failed to push release constants update to main after ${attempts} attempts" >&2
exit 1
