#!/usr/bin/env bash
#
# Decides whether a CircleCI post-merge macOS job for an older main commit can be
# skipped because a newer main commit will validate a superset of its changes
# (#11010). CircleCI runs one macOS job at a time for this organization, so a burst
# of merges must collapse into one post-merge run per path group.
#
# Usage: scripts/ci/circleci-main-superseded.sh <pipeline-parameter>
#
# Exit 0  superseded: some commit in <this SHA>..<origin/main tip> changes a path
#         mapped to <pipeline-parameter> in the mapping file, so that commit's own
#         pipeline also schedules this job and validates a tree containing ours.
#         By induction the last such commit in a burst is never superseded, so
#         exactly one run survives per burst.
# Exit 1  not superseded (this SHA is the tip, or no newer commit touches the
#         group), or the check could not be completed. Any doubt runs the job.
#
# Environment:
#   CIRCLE_SHA1                     commit under test (required)
#   CIRCLECI_MAIN_MAPPING_FILE      mapping file (default .circleci/main-macos-paths.txt);
#                                   the same "<regex> <parameter> <value>" lines the
#                                   path-filtering orb reads in .circleci/config.yml
#   CIRCLECI_MAIN_REMOTE            remote to read main from (default origin)
#   CIRCLECI_MAIN_BRANCH            branch name (default main)

set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "usage: circleci-main-superseded.sh <pipeline-parameter>" >&2
  exit 2
fi
parameter="$1"
mapping_file="${CIRCLECI_MAIN_MAPPING_FILE:-.circleci/main-macos-paths.txt}"
remote="${CIRCLECI_MAIN_REMOTE:-origin}"
branch="${CIRCLECI_MAIN_BRANCH:-main}"
sha="${CIRCLE_SHA1:-}"

run_job() {
  echo "circleci-main-superseded: $1; running the job." >&2
  exit 1
}

[[ -n "${sha}" ]] || run_job "CIRCLE_SHA1 is unset"
[[ -f "${mapping_file}" ]] || run_job "mapping file ${mapping_file} is missing"

patterns=()
while read -r regex mapped_parameter _value; do
  if [[ -n "${regex}" && "${mapped_parameter}" == "${parameter}" ]]; then
    patterns+=("^${regex}\$")
  fi
done < "${mapping_file}"
[[ ${#patterns[@]} -gt 0 ]] || run_job "no ${parameter} paths in ${mapping_file}"

if ! tip="$(git ls-remote "${remote}" "refs/heads/${branch}" | awk 'NR == 1 { print $1 }')" \
  || [[ -z "${tip}" ]]; then
  run_job "could not read ${remote}/${branch}"
fi
if [[ "${tip}" == "${sha}" ]]; then
  run_job "${sha} is the ${branch} tip"
fi
if ! git fetch --quiet --filter=blob:none "${remote}" "${tip}" 2>/dev/null; then
  run_job "could not fetch ${tip}"
fi
if ! git merge-base --is-ancestor "${sha}" "${tip}"; then
  run_job "${sha} is not an ancestor of ${branch} tip ${tip}"
fi
if ! changed="$(git -c core.quotepath=false diff --name-only "${sha}" "${tip}")"; then
  run_job "could not diff ${sha}..${tip}"
fi

for pattern in ${patterns[@]+"${patterns[@]}"}; do
  # ERE, not PCRE: the macOS executor ships BSD grep. The mapping regexes use only
  # the subset both dialects share (., .*, [^/]*, \.).
  if match="$(grep -E -m 1 -- "${pattern}" <<< "${changed}")"; then
    echo "circleci-main-superseded: ${branch} tip ${tip} also changes ${match} (${parameter}); skipping ${sha}." >&2
    exit 0
  fi
done
run_job "no commit after ${sha} changes ${parameter} paths"
