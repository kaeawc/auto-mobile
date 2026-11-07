# Pre-push vs CI misses

What CI catches that `scripts/prepush.sh` does not, ranked by the CI cost a
local check would have saved, and the cheapest local check for each. The ranking
comes from classifying failed `Pull Request` and `On Merge` jobs with
`scripts/ci/classify-failure.sh` and replaying each PR's changed paths through
`scripts/prepush.sh --list`. Advisory macOS simulator, emulator and device
capture lanes are excluded: they are runner-health signals pre-push cannot
reproduce, and `scripts/ci/known-flakes.txt` owns them.

## Ranked misses

| Rank | CI failure                                                                                                                                                                                                                | Why pre-push missed it                                                                                                                                                                                              | Cheapest local check                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1    | `Enforce 100ms budget for merged/changed unit tests` with a confirmed isolated median (Node Unit Tests, Node TypeScript Build and Test, TypeScript Code Coverage)                                                         | `prepush-node.sh` runs the timing gate only on Linux or with `--timing`; on macOS it prints a skip and passes                                                                                                       | Run the node lane with the timing gate wherever the unit lane runs (`prepush-node.sh --timing`, or the Linux cloud profile) |
| 2    | Main-red bursts inherited by every open PR: Fast Validation `ktfmt`, `shared-process-allowlist`, `shellcheck`, `pipefail-grep-q`, `shell-sete`, `codex-skills`, `mkdocs-nav`, `bun-version-coherence`, `tool-definitions` | A PR merged while its own Fast Validation or Shell Changed Files check was red, or two green PRs combined red (base skew). One such merge turns into tens of failed jobs on unrelated PRs                           | Run the selected lanes on a branch that contains the current `origin/main`; only the node lane refuses a stale base today   |
| 3    | `Shell Changed Files` / Fast Validation `docs-github-markdown`, `mkdocs-nav`, `xml`, and BATS files that name a `scripts/**/*.ts` input                                                                                   | Docs, skills, `.github/`, XML, test-plan YAML and non-shell `scripts/` paths must select the shell lane, because `prepush-shell.sh` (the selector CI's required `Shell Changed Files` job runs) has checks for them | `shell_lane_for_path` in `prepush.sh` routes every such path to the shell lane; the lane exits in seconds when nothing applies  |
| 4    | Windows-only unit and host-integration failures (`Node Unit Tests (windows-latest)`)                                                                                                                                      | No local lane runs on Windows                                                                                                                                                                                       | None locally; CI is the only Windows run. Keep path, process and socket code behind the existing platform seams             |
| 5    | Post-merge-only jobs: full-tree `Detekt`, `Validate Documentation Links`, the BATS unit lane wall budget                                                                                                                  | Detekt is module-scoped locally by design; online link rot and slow runners are not caused by the change                                                                                                            | None cheaper than CI: the scoped Detekt smoke check and offline lychee already run locally                                  |

## Lane selection contract

`scripts/prepush.sh` must select a lane for every path that lane's own selector
acts on, so a pass locally means the matching required CI job would pass for the
same diff. The shell lane is the selector `Shell Changed Files` runs, so its path
list in `prepush.sh` (`shell_lane_for_path`) mirrors the `case` arms in
`scripts/prepush-shell.sh`; `test/bats/prepush.bats` pins one path per arm.
