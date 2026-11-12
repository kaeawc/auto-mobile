# Unit lane scaling

How `scripts/test-ts.sh unit` spreads the Node unit lane over shards and processes (#10583). Under
`--isolate` most of the lane's time is per-file realm setup and module re-import, not test bodies, so
files that cannot leak state share one process.

## Shards

`scripts/test-ts.sh` assigns files round-robin: it walks the sorted `find test -name '*.test.ts'`
list (shared-allowlist files first) and gives file `i` to shard `i mod N`, so each shard gets an even
share of both groups. Each shard runs its shared files in one `bun test` process without `--isolate`
(`scripts/lib/bun-unit-groups.sh`), then its other files under `--isolate`. Both use the canonical
flags and preloads and run under the shard's single watchdog. JUnit goes to `shard-N-shared.xml` and
`shard-N-iso-K.xml`; the timing gate globs `*.xml`.

### Isolated chunks

The isolated group runs in sequential `bun test --isolate` processes of
`AUTOMOBILE_UNIT_ISOLATED_CHUNK_SIZE` files (default 30; `0` = one process), because a long isolated
process slows as it grows (#10213). Chunked shards (`AUTOMOBILE_UNIT_TEST_CHUNK_FILES`, nightly macOS)
chunk each group separately and never mix them.

### Wall time, reaping and retries

Each shard subshell writes its own elapsed seconds to `scratch/test-ts-<mode>-shards/shard-N.wall`,
and `test-ts: unit shard N/M wall=` reports that, falling back to the reap-time measurement only when a
killed shard wrote none. The bats test
`unit shard wall time is each shard's own duration, not its reap time (#10583)` covers it.

The parent reaps attempts in completion order. It polls the live
shard pids (`AUTOMOBILE_UNIT_SHARD_POLL_SECONDS`, default 0.2 s, because macOS
Bash 3.2 has no `wait -n`). A shard that infra-exits early is retried at once,
and its retry window is judged against the lane cap at its own end time. A
wall-budget timeout whose own attempt calibration reaches
`AUTOMOBILE_UNIT_CONTENDED_SLOWDOWN` (default 2.5x) skips the same-runner retry
and reports `RUNNER-CONTENDED`. A failing unit job (`Node Unit Tests`, `Node TypeScript Build and Test`, a `TypeScript Code Coverage (N/2)` part) qualifies
itself: its last step (`if: failure()`) runs
`scripts/ci/rerun-contended-runner.sh dispatch` against the job's own step summary,
and on attempt 1 only dispatches the `workflow_dispatch` Rerun contended runner
workflow (#12758). That workflow waits, bounded, for the run to finish,
re-verifies from the fetched logs that every failed job is a unit lane carrying
the marker, then reruns the failed jobs once. Fork PRs have a read-only token, so
the dispatch is skipped or logs a warning and never fails the job; a log-fetch
failure is a logged skip. The per-shard `.wall` record still excludes the end probe and the poll latency.

## Which files share a process

| Tier                    | Rule                                                                                                                                                 | Runs     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **A: must isolate**     | `mock.module`, native/global patching, `chdir`. These change the module registry or process-wide natives, and `afterEach` cannot reliably undo them. | Isolated |
| **B: restorable state** | Any other signal: spies not proven restored, env writes, singletons, DB, `testOverrides`, system time, `moduleState`.                                | Isolated |
| **C: no signal**        | Pure tests over injected fakes, and spy-only files whose every spy is proven restored.                                                               | Shared   |

`moduleState` is free-function `set…(`/`reset…(` calls (`setDeviceToolsDependencies`,
`setObserveCacheStore`, `resetAdbClientCaches`) and `X.resetForTests()`, not methods on fakes or timer
globals. Files that write state through a production default collaborator a static check cannot see
are listed in `SHARED_PROCESS_EXCLUSIONS` with the reason.

### Spy restore proof

Spies must be installed directly in a test or `beforeEach` callback; `beforeAll`, module/describe
bodies and helper-installed spies remain isolated, even with a restore hook.

The AST proof accepts an immediate `.mockRestore()`, a `using` declaration,
or a matching lexical variable/static field/array handle restored
unconditionally in the same test or a covering `afterEach`/`afterAll`.
Known `mockImplementation`/return-value chains preserve the handle. A covering
unconditional `mock.restore()`, `restoreAllMocks()` or `jest.restoreAllMocks()`
teardown also qualifies. Sibling/child describe hooks, conditional cleanup,
shadowed or overwritten handles, and unknown data/control flow do not prove a
restore. This is a bounded structural proof, not full exception-path analysis;
use `try/finally` for cleanup that must survive a failed assertion. There is no
blanket restore preload: it breaks suites that deliberately retain spies.

`bun scripts/test/classify-shared-safe.ts --explain` prints
`file:line:reason` for files blocked only by unproven spies. Supply a unit path
to inspect its unproven sites even when other signals also block it. `--check`
reports these sites if a listed file loses its restore proof.

### Allow-list, runner and leak detection

- **The list.** `test/shared-process-allowlist.txt` holds the shared files.
  `bun scripts/test/classify-shared-safe.ts` generates it from the tier
  signals above. Fast Validation runs
  the script with `--check` (`shared-process-allowlist`). The check fails when a listed file
  gained a tier A or B signal, no longer exists, is excluded, or when the list
  is unsorted or has duplicates. A new tier C file that is not listed only
  prints a hint: files that are not listed run isolated.
- **The runner.** See [Shards](#shards). The changed lane, coverage and explicit file
  targets do not split groups. `AUTOMOBILE_UNIT_SHARED_PROCESS=0`
  restores the all-isolated lane. Windows unit tests run in concurrent Bun
  `--shard` processes without isolation; `AUTOMOBILE_UNIT_TEST_WORKERS=1`
  restores the single command. Windows host integration runs all existing
  unsafe-tier files in one isolated process beside safe shards that also include
  unlisted files; `AUTOMOBILE_INTEGRATION_TEST_WORKERS=1` restores its single command.
  Unlike `scripts/prepush-integration-safe.sh`, Windows integration processes are
  not given isolated `AUTOMOBILE_*` state paths, so a safe-tier file that falls
  back to a default path can meet the unsafe process; fix a Windows-only flake
  that appears only with concurrency in the test or reclassify the file `unsafe`,
  with `AUTOMOBILE_INTEGRATION_TEST_WORKERS=1` as the kill switch.
  Any passthrough argument or non-empty `AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS`
  keeps both Windows lanes in a single process.
- **Timing probe.** A shared process runs the preloads once. The probe
  therefore records one entry per shared process, labelled through
  `AUTOMOBILE_TEST_TIMING_GROUP_LABEL`, for example
  `unit shard 0 shared process (360 files)`. The watchdog names that label, and
  the per-file headers in Bun's log name the file.
- **Leak detection.** The nightly `Node Randomized Unit Tests` job runs
  every unit file, including the shared group, in one non-isolated process with
  `--randomize --seed=<run number>`, so the shared group runs in a new random
  order every night.

A leak no seed has hit can surface on an unrelated PR, because adding or removing a file shifts which
files share a process and their order. Fix a listed victim by excluding the victim or polluter (or
fixing its reset), not by re-running.

## Host coordination and cancellation

Unit and changed lanes acquire host slots before choosing their shard
count. `AUTOMOBILE_HOST_TEST_SLOTS` defaults to ceil(logical cores / 2), minimum
two; `off` disables it. The shared pool lives in the coordination directory's
`test-slots` subdirectory. A sole holder of the entire pool can acquire extra
slots up to its existing worker demand, retaining idle-host and hosted-runner
parallelism. Other concurrent lanes use remaining base slots, or one unslotted
worker if none are free. Explicit `AUTOMOBILE_UNIT_TEST_WORKERS` remains an
upper bound. Targeted `--parallel` also respects the selected file count.

Signal/EXIT cleanup stops shard and watchdog process groups and releases
slots. Watchdogs notice a dead caller within a one-second poll, and chunk
loops check the original lane owner before each group. See
`scripts/README.md` for the environment controls and overloaded-host retry
suppression. Changed-file selection remains Bun's responsibility.

## Coverage lane

On Merge's instrumented lane (`scripts/test-ts.sh coverage`) runs as two
`TypeScript Code Coverage (N/2)` part jobs of two shards each. A 4-core runner
is already CPU-bound at two instrumented Bun shards, so a third shard on the
same host does not help; the split halves wall time instead, keeping each shard
inside its 720 s budget on the slower runner class. Part P
(`AUTOMOBILE_COVERAGE_PART`/`AUTOMOBILE_COVERAGE_PARTS`) takes every second
discovered file from offset P-1 and numbers its shards after the earlier
parts', so the parts interleave like one four-shard lane and their chunk
reports and calibration labels never collide. The `TypeScript Code Coverage`
job joins the parts (`scripts/ci/merge-ts-coverage-parts.sh`) for the badge
and runs the 100 ms gate over every chunk report. Coverage discovery skips
`test/lint/**` and `test/scripts/**`: they scan repository files rather than
exercise `src/`, and still run uninstrumented in the unit lanes.

## Background

- [Unit lane scaling study](../../devlog/2026-10-08-unit-lane-scaling-study.md)
- [Spy-only unit files in the shared process](../../devlog/2026-10-20-unit-lane-scaling-spy-only-shared.md)
