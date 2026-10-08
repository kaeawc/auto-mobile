# Unit lane scaling: where the time goes

This is the measurement half of issue #10583. It answers three questions with
data: where the Node unit lane's wall time goes, which test files need
`--isolate`, and whether duration-based shard assignment is worth adopting.

## Method

- **Host:** Apple M3 Max (16 cores), Bun 1.3.14, `origin/main` at `2769b96a5`
  (2026-10-08).
- **File list:** the canonical unit list. That is every tracked `test/**/*.test.ts`
  except `*.integration.test.ts`, `test/integration/`, `test/stress/` and
  `test/daemon/manager.test.ts`, which leaves **1,919 files and 40,468 tests**.
- **Runs:** sequential batches of 60 files, one `bun test` process per batch,
  never two at once. Each run used the canonical flags (`--timeout 20000
--no-orphans`, the `bunfig.toml` preloads and `test/setup/fileTimingProbe.ts`),
  with and without `--isolate`, and produced JUnit and per-file timing logs.
- **Sample:** every 19th file of the sorted list, 101 files in all. It was used
  for the one-process-per-file and cold-transpile-cache runs.
- **CI data:** Read-only `gh` reads of ubuntu-latest `Node Unit Tests` job logs,
  for example the green run 37710748903, and the nightly
  `Node Randomized Unit Tests` jobs.

The timing probe logs `start` when its preload runs, which is after the
`bunfig.toml` preloads and before the test file is imported. It logs `end` in a
global `afterAll`. Under `--isolate` this splits each file's cost into:

- **gap**: from the previous file's `end` to this file's `start`. This covers
  isolate teardown and setup and the three `bunfig.toml` preloads.
- **elapsed**: from `start` to `end`. This covers the module import of the test
  file and its graph, `beforeAll`/`afterAll` hooks, and the tests themselves.
- **test time**: the sum of JUnit `<testcase time>`. This excludes hooks and
  imports.

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

- **The known "~30 s of test time against ~186 s of wall" checks out.** Test
  bodies are 34 s, about 17% of the wall. The other 83% is re-creating a realm
  and re-importing each file's module graph once per file.
- **Isolation also inflates the test bodies themselves.** Without `--isolate`
  the JUnit test-time sum falls from 34.0 s to 18.5 s. Cold JIT state and lazy
  imports inside the first test of each file get paid again in every fresh realm.
- **The isolate overhead is about 82 ms per file across the suite**
  ((205 s − 48 s) / 1,919). On the 101-file sample it is about 122 ms per file
  (15.3 s against 3.0 s).
- **The slowest files by wall are `test/lint/*` suites at 0.8–1.6 s each, with
  1–33 ms of test time.** Their cost is in `beforeAll`, which scans `src/`. The
  JUnit-based 100 ms gate does not see it.

### Sample of 101 files: process, isolate and transpile cache

| Mode (101 files)                                                       | Wall   | Per file |
| ---------------------------------------------------------------------- | ------ | -------- |
| One `bun test` process per file (`--isolate`)                          | 20.8 s | 206 ms   |
| One process, `--isolate`, warm transpiler cache                        | 15.3 s | 152 ms   |
| One process, `--isolate`, cold (`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`) | 17.5 s | 173 ms   |
| One process, shared realm, warm                                        | 3.0 s  | 30 ms    |
| One process, shared realm, cold                                        | 3.1 s  | 31 ms    |

- **A fresh process costs about 60 ms at minimum.** That is the fastest
  one-file run: Bun startup plus the three preloads. The one-process-per-file
  median is 180 ms.
- **The transpiler cache is not the lever.** Cold against warm moves the
  isolated run by about 14% and the shared run by about 4%. Bun only caches
  large files, and nearly all of the cost is evaluating the module graph again
  per realm, not transpiling it. This matches #10429: our own module graph is
  the cost.

### CI (ubuntu-latest, 4 vCPU, 3 shards)

The green run 37710748903 has these shards. "Ran" is Bun's own per-shard
duration, and "Completed test-file time" is the probe's elapsed sum.

| Shard | Files | Tests  | Ran (Bun) | Probe elapsed sum | Gap (Ran − elapsed) |
| ----- | ----- | ------ | --------- | ----------------- | ------------------- |
| 1/3   | 642   | 13,703 | 520.5 s   | 345.4 s           | 175 s               |
| 2/3   | 641   | 13,836 | 521.7 s   | 348.1 s           | 174 s               |
| 3/3   | 641   | 13,106 | 428.5 s   | 283.0 s           | 146 s               |

- **CI pays about 7.6 times the local per-file cost.** That is 1,471
  shard-seconds against 205 s locally. Three concurrent realms on 4 vCPU, plus
  the runner's own load, slow every import.
- **The gap share matches local.** About 33% of CI shard time is inter-file
  isolate overhead, against 29% locally.
- **Timeouts and runner shutdowns dominate the red runs.** From 2026-10-07 to
  2026-10-08, 11 of the 14 most recent ubuntu unit jobs in the PR workflow (and nearly every merge-workflow run) died with
  `exit 143` (runner shutdown) or `124`. On every `124` run, all three shards hit
  the budget together (758–785 s). That points to a slow runner, not an
  unbalanced one.
- **The nightly randomized lane runs the whole suite in one non-isolated
  process in 76–95 s on ubuntu.** That is the canonical sharded lane's
  ~520 s shard wall cut by about 5.5 times. It surfaces about 6 failures in 3
  files per night (`navigation resource session resolution`,
  `structural SQLite characterization`, `navigation recorder caller arguments`,
  and the WebRTC publish teardown suite). Those are order-dependent leaks.

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

The proposed classification:

| Tier                    | Rule                                                                                                                                                 | Files | Isolated cost |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------- |
| **A: must isolate**     | `mock.module`, native/global patching, `chdir`. These change the module registry or process-wide natives, and `afterEach` cannot reliably undo them. | 34    | 3.6 s         |
| **B: restorable state** | Any other signal: spies, env writes, singletons, DB, `testOverrides`, system time. These are safe only if every test restores.                       | 707   | 101.7 s       |
| **C: no signal**        | Pure tests over injected fakes.                                                                                                                      | 1,178 | 97.3 s        |

Measured outcomes for running subsets in a shared realm:

| Shared set (batches)                                        | Files | Shared wall | Failures                                                             |
| ----------------------------------------------------------- | ----- | ----------- | -------------------------------------------------------------------- |
| Tier C (60-file batches)                                    | 1,178 | 24.3 s      | 0                                                                    |
| Tier C (400-file batches, `--randomize --seed=10583`)       | 1,178 | 17.8 s      | 0                                                                    |
| Tier C + B minus {DB, singleton, env, `testOverrides`} (60) | 1,562 | 33.4 s      | 4 tests in `BaseVisualChange.uiStability.test.ts` (leaked spy state) |
| Everything (60)                                             | 1,919 | 48.2 s      | 0 in this order; nightly random order fails ~3 files                 |

The estimated local saving if Tier C shares processes and A+B stay isolated
is 97.3 s of isolated cost replaced by 17.8–24.3 s shared. That takes the
suite from **205 s to about 125–130 s (−37 to −39%)**. The same ratio on the
CI shard would take about 520 s to about 330 s.

**The study did not adopt this, because it changes the lane's hermeticity
contract. The owner decided on 2026-10-08 to adopt it for tier C; section 5
describes the change.**

- A Tier C file that passes only because an earlier file in its batch left
  state behind would no longer fail on its own. The nightly randomized lane is
  the backstop for that.
- The tiering is a static heuristic. The run that also shared Tier B files
  without DB, singleton or env signals found a real leak at once, so the
  heuristic needs a curated allow-list or deny-list and a guard test before it
  gates CI.
- That is an owner decision. The pieces are: a checked-in list of shared-safe
  files or directories, `bun test` without `--isolate` over them, `--isolate`
  for the rest, a lint that moves a file to the isolated set when it gains a
  Tier A signal, and the randomized nightly run as the leak detector.

## 3. Shard balance

`scripts/test-ts.sh` assigns files round-robin. It walks the sorted
`find test -name '*.test.ts'` list and gives file `i` to shard `i mod N`. Each
shard is one `bun test --isolate` process.

Simulated with the measured local per-file costs (gap + elapsed):

| Shards | Round-robin (current) max / mean | LPT, exact manifest | LPT, ±50% per-file drift | LPT, 10% unknown files (round-robin fallback) |
| ------ | -------------------------------- | ------------------- | ------------------------ | --------------------------------------------- |
| 2      | +5.9% / −5.9%                    | ±0.0%               | ±0.1%                    | ±1.0%                                         |
| 3      | +2.0% / −2.7%                    | ±0.0%               | +1.6% / −1.6%            | ±0.2%                                         |
| 4      | +14.7% / −7.0%                   | ±0.0%               | +0.8% / −1.6%            | +1.2% / −1.7%                                 |
| 6      | +11.5% / −10.2%                  | ±0.0%               | +1.9% / −2.2%            | +2.0% / −1.6%                                 |

On CI at 3 shards, the observed spread on the green run above is
**+6.4% / −12.6%**: 521.7 s and 520.5 s against 428.5 s, with a mean of 490 s.
LPT would cut the critical path by about 6% (about 31 s), and by less
when per-file costs on the runner drift from the manifest.

**Recommendation: do not adopt duration-based assignment now.**

- **Balance is already within the issue's ±20% target.** It gains 2–6% at
  3 shards. It only pays at 4–6 shards, which the ubuntu runner, at 3 workers
  on 4 vCPU, does not use.
- **It would not have prevented the observed failures.** Every `124` timeout
  had all three shards at the budget together, and `143` is a runner shutdown.
- **A manifest is ongoing cost.** It needs a refresh job and churns as files
  are added, and CI per-file costs (`TargetDisplayAction` at 14 s on CI) are
  not proportional to local ones.

Revisit it if the lane moves to more shards or runners. Build the manifest from
CI JUnit and probe data (`scratch/test-ts-unit-shards/timing-shard-*.ndjson`),
not local runs, and fall back to round-robin for unknown files.

## 4. Change made: accurate per-shard wall time

The study found that `test-ts: unit shard N/M wall=` was wrong. The parent
reaps shards in index order and computed each shard's wall at reap time. Every
shard reaped after the slowest earlier one therefore reported that shard's
time. That is why CI showed `wall=523s` for all three shards when Bun's own
times were 520.5, 521.7 and 428.5 s. Any balance or p50/p95 tracking needs
correct per-shard numbers, as the issue's "track the lane's health" option and
its ±20% acceptance do.

Each unit shard subshell now writes its own elapsed seconds to
`scratch/test-ts-<mode>-shards/shard-N.wall` before the timing summary runs. The
parent reports that value. It keeps the reap-time measurement only when a
killed shard wrote no record. The bats test `unit shard wall time is each
shard's own duration, not its reap time (#10583)` covers it: a slow shard 0 and
a fast shard 1 must report different walls.

Since #10644 the parent reaps attempts in completion order. It polls the live
shard pids (`AUTOMOBILE_UNIT_SHARD_POLL_SECONDS`, default 0.2 s, because macOS
Bash 3.2 has no `wait -n`). A shard that infra-exits early is retried at once,
and its retry window is judged against the lane cap at its own end time. The
per-shard `.wall` record still excludes the end probe and the poll latency.

## 5. Change made: tier C files share processes

The owner decided on 2026-10-08 to run tier C files in shared processes and
keep everything else isolated.

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
  separately and never mix them. The changed lane, coverage, explicit file
  targets and Windows are unchanged. `AUTOMOBILE_UNIT_SHARED_PROCESS=0`
  restores the all-isolated lane.
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

The study ran tier C once in a random order. Running the whole group in one
process under further seeds found three order-dependent failures, each
bisected to a single earlier file:

| Victim                                  | Polluter                                     | State                                                                                                    |
| --------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `androidInventoryMixedWorkload.test.ts` | `AndroidEmulatorClient-killIdentity.test.ts` | AdbClient's module-level device-list cache. The victim resets it only in `afterEach`.                    |
| `androidInventoryReviewFix.test.ts`     | not bisected                                 | Same cache, also reset only in `afterEach`.                                                              |
| `ObserveCacheRegistry.test.ts`          | `AndroidMultiDisplayActivity.test.ts`        | `ObserveScreen` installs its `cacheStore` with the module-level `setObserveCacheStore`.                  |
| `BaseVisualChange.uiStability.test.ts`  | `ClearAppData.test.ts`                       | The default window-cache invalidator marks a pending window resolution for `device-123` in a module map. |

The classifier therefore adds a tier B signal, `moduleState`. It matches
free-function `set…(`/`reset…(` calls, such as `setDeviceToolsDependencies`,
`setObserveCacheStore` and `resetAdbClientCaches`, and `X.resetForTests()`. It
does not match methods on fakes or the timer globals. It moved 93 files out of
the shared group, which catches the first three victims. In the last pair, the
state is written through a production default collaborator, which a static check of the test file cannot
see, so both files are in the script's `SHARED_PROCESS_EXCLUSIONS` with the
reason. That leaves 1,079 shared files, down from 1,174.

With those changes, nine further seeds (3, 7, 8, 11, 12, 13, 14, 15 and
20261008, which include every seed that had failed) ran the 1,079 shared files
in one process with 0 failures, in 16–28 s each.

The residual risk is that the shard lists are round-robin over the sorted file
list. Adding or removing a test file therefore shifts which files share a
process and in what order. A leak that no seed has hit yet could surface on an
unrelated PR. The nightly random lane is the detector. A failure there in a
listed file is fixed by adding the victim or the polluter to the exclusions
(or fixing its reset), not by re-running.

### Measured result

The run used the same host, the shard contents `test-ts.sh` builds for 3
shards, and every process run sequentially. `test/daemon/manager.test.ts` was
skipped (1,923 files).

| Layout                       | Shard 1 | Shard 2 | Shard 3 | Sum of shard time | Failures |
| ---------------------------- | ------- | ------- | ------- | ----------------- | -------- |
| Before: all files isolated   | 231.3 s | 203.7 s | 224.6 s | 659.6 s           | 0        |
| After: 1,079 shared, 844 iso | 112.1 s | 122.0 s | 109.7 s | 343.9 s           | 0        |

Each shard's critical path falls by about 47%. Each shared process took
5–7 s for its 359–360 files. The isolated per-file cost in a 281–641-file
process is about 0.36 s locally. That is much higher than the 86 ms of the
60-file batches in section 1, which suggests long isolated processes slow down
as they grow (compare #10213).

### Chunking the isolated group

The isolated group of a shard now runs in sequential `bun test --isolate`
processes of `AUTOMOBILE_UNIT_ISOLATED_CHUNK_SIZE` files (`0` = one process),
with JUnit reports `shard-N-iso-K.xml` (`scripts/lib/bun-unit-groups.sh`).
Measured locally on shard 0's 211 isolated files (4 shards), run
sequentially, each size twice in opposite order on a loaded machine (load
35–83), wall seconds:

| Chunk size      | Run 1 | Run 2 |
| --------------- | ----- | ----- |
| 0 (one process) | 78.3  | 97.0  |
| 120             | 51.2  | 49.0  |
| 60              | 35.6  | 45.2  |
| 30              | 28.0  | 34.3  |

Smaller chunks were faster at every size measured, so the default is 30. The
absolute numbers are noisy because other lanes shared the host, but the order
held in both passes.

## Summary of the decisions this informs

| Question                      | Finding                                                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where does wall time go?      | 83% is per-file realm setup and module re-import under `--isolate`. Test bodies are 17%. Process startup and the transpiler cache are minor.             |
| Biggest lever                 | Fewer isolates. Sharing processes for the 1,178 no-signal files cuts the suite by about 37%. A fully shared realm cuts it by 77% but leaks across files. |
| Shard balancing               | Round-robin is within ±13% on CI at 3 shards. LPT gains about 6% and does not address the timeouts.                                                      |
| Timeout and shutdown failures | Runner-wide slowness, which hits all shards together. Fewer isolates shorten the window, and a retry or infra classification handles the remainder.      |
