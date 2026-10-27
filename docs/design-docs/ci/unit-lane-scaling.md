# Unit lane scaling: where the time goes

This is the measurement half of issue #10583. It answers three questions with
data: where the Node unit lane's wall time goes, which test files need
`--isolate`, and whether duration-based shard assignment is worth adopting.

## Method

Apple M3 Max (16 cores), Bun 1.3.14, `origin/main` at `2769b96a5` (2026-10-08). File list: every
tracked `test/**/*.test.ts` except `*.integration.test.ts`, `test/integration/`, `test/stress/`
and `test/daemon/manager.test.ts` (1,919 files, 40,468 tests). Sequential batches of 60 files, one
`bun test` per batch, canonical flags (`--timeout 20000 --no-orphans`, `bunfig.toml` preloads,
`test/setup/fileTimingProbe.ts`), with and without `--isolate`. A 101-file sample (every 19th)
drove the process-per-file and cold-transpile-cache runs. CI data came from read-only `gh` reads
of `Node Unit Tests` logs (green run 37710748903) and nightly `Node Randomized Unit Tests`.

The probe logs `start` after the `bunfig.toml` preloads and before the test file is imported, and
`end` in a global `afterAll`. Under `--isolate` that splits each file's cost into **gap** (previous
`end` to this `start`: isolate teardown/setup plus preloads), **elapsed** (module import of the
file's graph, hooks, tests) and **test time** (JUnit `<testcase time>` sum, excluding hooks and imports).

## 1. Where the wall time goes

### Whole suite, local

| Mode (32 batches of 60)       | Wall      | Failures |
| ----------------------------- | --------- | -------- |
| `--isolate` (canonical)       | **205 s** | 0        |
| no `--isolate` (shared realm) | **48 s**  | 0        |

The `--isolate` run breaks down as follows:

| Component                                 | Time    | Share | Per file (median / p90) |
| ----------------------------------------- | ------- | ----- | ----------------------- |
| Process start + exit (32 processes)       | 2.4 s   | 1%    | 75 ms per process       |
| Inter-file gap (isolate reset + preloads) | 59.1 s  | 29%   | 26 ms / 57 ms           |
| Import + hooks (elapsed − test time)      | 109.6 s | 53%   | 43 ms                   |
| Test time (JUnit sum)                     | 34.0 s  | 17%   |                         |
| **Total per-file cost**                   | 202.6 s |       | 86 ms / 206 ms          |

- Test bodies are only ~17% of wall; the rest is re-creating a realm and re-importing each file's
  module graph once per file (~82 ms per file; ~122 ms on the sample).
- Isolation also inflates test bodies: the JUnit sum falls from 34.0 s to 18.5 s without `--isolate`
  (cold JIT state and lazy imports are paid again in each fresh realm).
- The slowest files by wall are `test/lint/*` suites (0.8-1.6 s, 1-33 ms of test time); their cost
  is in `beforeAll`, which scans `src/`, and the JUnit-based 100 ms gate does not see it.

### Sample of 101 files: process, isolate and transpile cache

| Mode (101 files)                                                       | Wall   | Per file |
| ---------------------------------------------------------------------- | ------ | -------- |
| One `bun test` process per file (`--isolate`)                          | 20.8 s | 206 ms   |
| One process, `--isolate`, warm transpiler cache                        | 15.3 s | 152 ms   |
| One process, `--isolate`, cold (`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`) | 17.5 s | 173 ms   |
| One process, shared realm, warm                                        | 3.0 s  | 30 ms    |
| One process, shared realm, cold                                        | 3.1 s  | 31 ms    |

- A fresh process costs at least ~60 ms (Bun startup plus the three preloads); the
  one-process-per-file median is 180 ms.
- The transpiler cache is not the lever: cold vs warm moves the isolated run ~14% and the shared
  run ~4%. Nearly all the cost is evaluating the module graph again per realm (see #10429).

### CI (ubuntu-latest, 4 vCPU, 3 shards)

The green run 37710748903 has these shards. "Ran" is Bun's own per-shard
duration, and "Completed test-file time" is the probe's elapsed sum.

| Shard | Files | Tests  | Ran (Bun) | Probe elapsed sum | Gap (Ran − elapsed) |
| ----- | ----- | ------ | --------- | ----------------- | ------------------- |
| 1/3   | 642   | 13,703 | 520.5 s   | 345.4 s           | 175 s               |
| 2/3   | 641   | 13,836 | 521.7 s   | 348.1 s           | 174 s               |
| 3/3   | 641   | 13,106 | 428.5 s   | 283.0 s           | 146 s               |

- CI pays ~7.6x the local per-file cost (1,471 shard-seconds vs 205 s): three concurrent realms on
  4 vCPU plus runner load slow every import. About 33% of CI shard time is inter-file isolate
  overhead (29% locally).
- Timeouts and runner shutdowns dominate red runs: 11 of the 14 most recent ubuntu unit jobs in the
  PR workflow (2026-10-07/08) died with `exit 143` (runner shutdown) or `124`; on every `124` all
  three shards hit the budget together (758-785 s), i.e. a slow runner, not an unbalanced one.
- The nightly randomized lane runs the whole suite in one non-isolated process in 76-95 s on ubuntu
  (~5.5x faster than the sharded lane's ~520 s shard wall). It surfaces ~6 order-dependent
  failures in 3 files per night.

## 2. Which files need isolation

Static signals were matched per file over the 1,919 unit files:

| Signal                                                                       | Files |
| ---------------------------------------------------------------------------- | ----- |
| `spyOn(`                                                                     | 554   |
| singleton access (`getInstance(`, `resetInstance`, `.instance =`, `__reset`) | 187   |
| `process.env` write or `delete`                                              | 134   |
| DB (`getDatabase`, `createTestDatabase`, the DB test harnesses)              | 60    |
| assignment to `childProcess.*`, `Bun.*`, `fs.*` or `process.*`               | 21    |
| `globalThis`/`global` write or `Object.defineProperty(globalThis…)`          | 11    |
| `testOverrides`                                                              | 5     |
| `mock.module(`                                                               | 2     |
| `process.chdir`                                                              | 2     |

Classification:

| Tier                    | Rule                                                                                                                                                 | Files | Isolated cost |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------- |
| **A: must isolate**     | `mock.module`, native/global patching, `chdir`. These change the module registry or process-wide natives, and `afterEach` cannot reliably undo them. | 34    | 3.6 s         |
| **B: restorable state** | Any other signal: spies, env writes, singletons, DB, `testOverrides`, system time. Safe only if every test restores.                                 | 707   | 101.7 s       |
| **C: no signal**        | Pure tests over injected fakes.                                                                                                                      | 1,178 | 97.3 s        |

Sharing tier C alone passed with 0 failures (24.3 s in 60-file batches, 17.8 s in 400-file random
batches). Also sharing tier B files without DB/singleton/env/`testOverrides` signals leaked spy state
at once (4 tests in `BaseVisualChange.uiStability.test.ts`), so the static heuristic needs a curated
list and a guard test. Sharing everything took 48.2 s (0 failures in sorted order; nightly random order
fails ~3 files). Estimated saving for tier C shared, A+B isolated: **205 s to ~125-130 s (-37 to
-39%)**. The owner decided on 2026-10-08 to adopt it for tier C (section 5). Risk: a tier C file that
passes only because an earlier file left state behind; the nightly randomized lane is the backstop.

## 3. Shard balance

`scripts/test-ts.sh` assigns files round-robin. It walks the sorted
`find test -name '*.test.ts'` list and gives file `i` to shard `i mod N`. Each
shard is one `bun test --isolate` process.

Simulated with measured per-file costs, LPT (longest-processing-time) assignment gains 2-6% at 3
shards and only pays at 4-6 shards (round-robin max imbalance +5.9% at 2, +2.0% at 3, +14.7% at 4,
+11.5% at 6). On CI at 3 shards the observed spread is **+6.4% / −12.6%** (521.7 s and 520.5 s vs
428.5 s, mean 490 s); LPT would cut the critical path ~31 s, less when runner costs drift from the manifest.

**Recommendation: do not adopt duration-based assignment now.**

- Balance is already within the issue's ±20% target and the ubuntu runner uses 3 workers on 4 vCPU.
- It would not have prevented the failures: every `124` had all shards at the budget together, and
  `143` is a runner shutdown.
- A manifest is ongoing cost (refresh job, churn as files are added), and CI per-file costs
  (`TargetDisplayAction` at 14 s on CI) are not proportional to local ones.

Revisit if the lane moves to more shards or runners. Build the manifest from CI JUnit and probe data
(`scratch/test-ts-unit-shards/timing-shard-*.ndjson`), not local runs, with round-robin for unknown files.

## 4. Change made: accurate per-shard wall time

`test-ts: unit shard N/M wall=` used to be wrong: the parent reaped shards in index order and
computed each wall at reap time, so every later shard reported the slowest earlier one's time
(`wall=523s` for all three when Bun reported 520.5, 521.7 and 428.5 s). Each shard subshell now
writes its own elapsed seconds to `scratch/test-ts-<mode>-shards/shard-N.wall`, and the parent reports
that, falling back to the reap-time measurement only when a killed shard wrote none. The bats test
`unit shard wall time is each shard's own duration, not its reap time (#10583)` covers it.

Since #10644 the parent reaps attempts in completion order. It polls the live
shard pids (`AUTOMOBILE_UNIT_SHARD_POLL_SECONDS`, default 0.2 s, because macOS
Bash 3.2 has no `wait -n`). A shard that infra-exits early is retried at once,
and its retry window is judged against the lane cap at its own end time. A
wall-budget timeout whose own attempt calibration reaches
`AUTOMOBILE_UNIT_CONTENDED_SLOWDOWN` (default 2.5x) skips the same-runner retry
and reports `RUNNER-CONTENDED`. A failing unit job (`Node Unit Tests`, `Node TypeScript Build and Test`, `TypeScript Code Coverage`) qualifies
itself: its last step (`if: failure()`) runs
`scripts/ci/rerun-contended-runner.sh dispatch` against the job's own step summary,
and on attempt 1 only dispatches the `workflow_dispatch` Rerun contended runner
workflow (#12758; it replaced a `workflow_run` trigger that started a run for every
Pull Request and On Merge run). That workflow waits, bounded, for the run to finish,
re-verifies from the fetched logs that every failed job is a unit lane carrying
the marker, then reruns the failed jobs once. Fork PRs have a read-only token, so
the dispatch is skipped or logs a warning and never fails the job; a log-fetch
failure is a logged skip. The per-shard `.wall` record still excludes the end probe and the poll latency.

## 5. Change made: tier C files share processes

The owner decided on 2026-10-08 to run tier C files in shared processes and
keep everything else isolated.

On 2026-10-20 (#13568 / #13854), the owner also allowed spy-only files into
Tier C when the classifier proves **every** spy is restored. The original
section 2 table and measurements above predate that decision. Other signals
still force isolation. Spies must be installed directly in a test or
`beforeEach` callback; `beforeAll`, module/describe bodies and helper-installed
spies remain isolated, even with a restore hook.

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

- **The list.** `test/shared-process-allowlist.txt` holds the shared files.
  `bun scripts/test/classify-shared-safe.ts` generates it from the section 2
  signals plus one more, `moduleState`, which is described below. Fast Validation runs
  the script with `--check` (`shared-process-allowlist`). The check fails when a listed file
  gained a tier A or B signal, no longer exists, is excluded, or when the list
  is unsorted or has duplicates. A new tier C file that is not listed only
  prints a hint: files that are not listed run isolated.
- **The runner.** `scripts/test-ts.sh unit` puts the listed files first and
  then assigns files round-robin, so each shard gets an even share of both groups.
  Each shard then runs its shared files in one `bun test` process without
  `--isolate` (`scripts/lib/bun-unit-groups.sh`), followed by its other files
  in one `--isolate` process. Both use the canonical flags and preloads and
  run under the shard's single watchdog. JUnit goes to `shard-N-shared.xml` and
  `shard-N.xml`, and the timing gate already globs `*.xml`. Chunked shards
  (`AUTOMOBILE_UNIT_TEST_CHUNK_FILES`, nightly macOS) chunk each group
  separately and never mix them. The changed lane, coverage and explicit file
  targets are unchanged. `AUTOMOBILE_UNIT_SHARED_PROCESS=0`
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
- **Leak detection.** The nightly `Node Randomized Unit Tests` job already runs
  every unit file, including the shared group, in one non-isolated process with
  `--randomize --seed=<run number>`. It covers the shared group in a new
  random order every night.

### Verification found leaks that the study's signals miss

Running the whole group in one process under further seeds found order-dependent failures, each
bisected to an earlier file:

| Victim                                  | Polluter                                     | State                                                                                             |
| --------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `androidInventoryMixedWorkload.test.ts` | `AndroidEmulatorClient-killIdentity.test.ts` | AdbClient's module-level device-list cache, reset by the victim only in `afterEach`.              |
| `androidInventoryReviewFix.test.ts`     | not bisected                                 | Same cache.                                                                                       |
| `ObserveCacheRegistry.test.ts`          | `AndroidMultiDisplayActivity.test.ts`        | `ObserveScreen` installs its `cacheStore` via module-level `setObserveCacheStore`.                |
| `BaseVisualChange.uiStability.test.ts`  | `ClearAppData.test.ts`                       | The default window-cache invalidator marks a pending resolution for `device-123` in a module map. |

The classifier therefore adds a tier B signal, `moduleState`: free-function `set…(`/`reset…(` calls
(`setDeviceToolsDependencies`, `setObserveCacheStore`, `resetAdbClientCaches`) and
`X.resetForTests()`, not methods on fakes or timer globals. It moved 93 files out of the shared
group. The last pair writes state through a production default collaborator a static check cannot
see, so both files are in `SHARED_PROCESS_EXCLUSIONS` with the reason. That leaves 1,079 shared
files; nine further seeds (3, 7, 8, 11, 12, 13, 14, 15, 20261008) ran them in one process with 0 failures.

Residual risk: shard lists are round-robin over the sorted list, so adding or removing a file shifts
which files share a process and their order, and a leak no seed has hit could surface on an unrelated
PR. The nightly random lane is the detector; fix a listed victim by excluding the victim or polluter
(or fixing its reset), not by re-running.

### Measured result

Same host, shard contents `test-ts.sh` builds for 3 shards, processes run sequentially,
`test/daemon/manager.test.ts` skipped (1,923 files):

| Layout                       | Shard 1 | Shard 2 | Shard 3 | Sum of shard time | Failures |
| ---------------------------- | ------- | ------- | ------- | ----------------- | -------- |
| Before: all files isolated   | 231.3 s | 203.7 s | 224.6 s | 659.6 s           | 0        |
| After: 1,079 shared, 844 iso | 112.1 s | 122.0 s | 109.7 s | 343.9 s           | 0        |

Each shard's critical path falls ~47%; each shared process takes 5-7 s for ~360 files. The isolated
per-file cost in a 281-641-file process is ~0.36 s, far above the 86 ms of 60-file batches, so long
isolated processes slow as they grow (see #10213).

### Chunking the isolated group

The isolated group of a shard now runs in sequential `bun test --isolate`
processes of `AUTOMOBILE_UNIT_ISOLATED_CHUNK_SIZE` files (`0` = one process),
with JUnit reports `shard-N-iso-K.xml` (`scripts/lib/bun-unit-groups.sh`).
Measured on shard 0's 211 isolated files (4 shards), two passes on a loaded host (wall seconds):
chunk 0 (one process) 78.3/97.0; 120: 51.2/49.0; 60: 35.6/45.2; 30: 28.0/34.3. Smaller chunks won at
every size, so the default is 30.

## Summary of the decisions this informs

| Question                      | Finding                                                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where does wall time go?      | 83% is per-file realm setup and module re-import under `--isolate`. Test bodies are 17%. Process startup and the transpiler cache are minor.             |
| Biggest lever                 | Fewer isolates. Sharing processes for the 1,178 no-signal files cuts the suite by about 37%. A fully shared realm cuts it by 77% but leaks across files. |
| Shard balancing               | Round-robin is within ±13% on CI at 3 shards. LPT gains about 6% and does not address the timeouts.                                                      |
| Timeout and shutdown failures | Runner-wide slowness, which hits all shards together. Fewer isolates shorten the window, and a retry or infra classification handles the remainder.      |

### Host coordination and cancellation

Unit and changed lanes now acquire host slots before choosing their shard
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
suppression. Changed-file selection remains Bun's responsibility; a shared
changed-file list is deferred.
