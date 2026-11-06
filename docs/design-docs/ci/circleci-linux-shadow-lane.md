# CircleCI Linux shadow lane

GitHub Actions is the authoritative CI. CircleCI additionally runs Linux mirrors
of the Node and shell validation jobs on every pull request so that capacity on
the CircleCI open-source plan is used and the two can be compared before any
required check moves.

## Jobs

`.circleci/continue_config.yml`, workflow `linux-pr`, selected by the `run-linux`
pipeline parameter. `.circleci/config.yml` sets it with the `.*` path-filter
mapping, so any PR that changes a file runs the lane.

| CircleCI job                        | Mirrors (pull_request.yml)    |
| ----------------------------------- | ----------------------------- |
| `linux-fast-validation`             | `fast-validation`             |
| `linux-node-checks`                 | `node-checks`                 |
| `linux-node-build-and-test`         | `ts-build-and-test`           |
| `linux-node-host-integration-tests` | `node-host-integration-tests` |
| `linux-bats-tests`                  | `bats-tests`                  |

All run on the `linux` executor (`cimg/openjdk:21.0-node`, `large`: 4 vCPU, 8 GB).

## Differences from the GitHub jobs

- No change detection: each job always runs its full set, where GitHub gates
  steps on `detect-changes` outputs.
- No GitHub token: the benchmark PR comment, artifact uploads and the
  contended-runner rerun dispatch are omitted; reports go to CircleCI artifacts.
- The PR base is `git merge-base origin/main HEAD` rather than the event's base SHA.
- Checkout is the LFS-free clone shared with the macOS jobs.

## Capacity

The open-source plan allows 30 concurrent Linux jobs and is not subject to the
Free plan's monthly credit cap. These jobs are not required checks, so a missing
or red CircleCI run never blocks a merge.

## Promotion

To make a mirror authoritative, swap the `green-main` ruleset contexts from the
GitHub job name to `ci/circleci: <job>` and delete the GitHub job in the same
change. Do not delete a GitHub job first: its required context would stop
reporting.
