# AutoMobile Scripts

This directory contains build, validation, and utility scripts for the AutoMobile project.

## Script References

Fast Validation checks that every tracked script under `scripts/` has an inbound reference.
Unused scripts belong in `conventions/unreferenced-scripts-allowlist.txt` with a reason.
When adding a script, wire it into a workflow, `package.json`, another script, or documentation.
Python modules ending in `.py` under `scripts/github/` and `scripts/manual-test/python/` count as
referenced through discovery when the root contains `pyproject.toml`, `requirements*.txt`, or `uv.lock`.

## MCP Context Management

### Context Estimation

Estimate token usage for MCP server components (tools, resources, templates):

```bash
bun run estimate-context
```

**Output:**

- Detailed breakdown of token usage per tool/resource
- Total token counts by category
- Sorted by token count (highest first)

**Options:**

```bash
# Include operation traces from a JSON file
bun run estimate-context --traces path/to/traces.json
```

**Use Cases:**

- Understanding current context usage
- Identifying token-heavy tools or resources
- Planning optimization efforts
- Generating baseline for threshold configuration

### Context Threshold Benchmark

Validate that MCP context usage stays within configured thresholds:

```bash
bun run benchmark-context
```

**Exit Codes:**

- `0` - All thresholds passed
- `1` - One or more thresholds exceeded or error occurred

**Options:**

```bash
# Use custom threshold configuration
bun run benchmark-context --config path/to/thresholds.json

# Output JSON report to file
bun run benchmark-context --output reports/benchmark.json
```

**Use Cases:**

- CI/CD threshold enforcement
- Pre-commit validation
- Regression detection
- Performance budget tracking

### Threshold Configuration

Thresholds are defined in `scripts/context-thresholds.json`:

```json
{
  "version": "2.0.0",
  "metadata": {
    "baseline": {
      "coreTools": 0,
      "allTools": 0,
      "resources": 0,
      "resourceTemplates": 0,
      "coreTotal": 0,
      "allTotal": 0
    }
  }
}
```

The benchmark compares both profiles against their recorded baselines. To record
a new baseline, run `bun run benchmark-context`, copy its six **Actual** values
into `metadata.baseline` in the chosen config, then rerun the benchmark to
verify every delta is zero. Do not copy the zeroes above into a working
configuration.

### Observe Output Byte Breakdown

Measure the byte breakdown of an `observe` (or `homeScreen`) tool result so
output-context reductions can be quantified against a fixed baseline:

```bash
scripts/observe-byte-breakdown.sh test/fixtures/observe/android-home.json
# or from stdin
cat result.json | scripts/observe-byte-breakdown.sh
```

**Output:**

- Total byte count of the observe result
- Per top-level field bytes and % of total (sorted largest first)
- Per `viewHierarchy` sub-key bytes and % of `viewHierarchy`
- gfxinfo duplication check (`performanceAudit.metrics.gfxinfoRaw` vs the copy
  embedded in `performanceAudit.diagnostics`)

Byte counts use the UTF-8 length of each value's **compact** JSON
serialization — a fast relative view of which fields dominate. This
under-counts the real wire size: the observe tool emits a larger pretty-printed
form with `extras` keys stripped (`stringifyToolResponse`), which for this
fixture is ~84.5 KB / ~21.9k tokens versus ~50 KB compact. The script
auto-unwraps `homeScreen`-style payloads that nest the result under
`.observation`, and rejects non-object / malformed JSON with a clean error.

**Baseline fixture & cap-accurate token measurement.**
`test/fixtures/observe/android-home.json` is the committed baseline home-screen
capture (Android only for now) that later reduction work is measured against.
Because the reduction effort is gated on the MCP output **token** cap, the
authoritative measurement lives in `test/fixtures/observe/observeFixture.ts` —
`measureObserveBreakdown()` serializes with the **production formatter**
(`stringifyToolResponse`, pretty-printed + `extras` stripped) and reports both
bytes and cl100k_base tokens per field (same tokenizer as
`estimate-context-usage.ts`). The baseline measures ~84.5 KB / ~21.9k tokens.
Later reduction unit tests import this helper to quantify token wins.
Regenerate the fixture by re-running the `observe` MCP tool against an Android
home screen and re-committing the pretty-printed JSON; treat it as a frozen
baseline and only refresh it deliberately when the observe output format changes.

## Mac Runner Queue Watchdog

`ci/mac-queue-watchdog.sh` reports self-hosted Mac jobs queued for 15 minutes
in a PR run attempt. It is advisory, reads jobs with `gh api --paginate` and
`jq`, and never cancels a run. `MAC_QUEUE_STUCK_SECONDS` and
`MAC_QUEUE_POLL_SECONDS` configure the threshold and poll interval;
`MAC_QUEUE_NOW_CMD` injects the clock for its BATS tests. Observation is bounded
by 15 minutes plus two polls by default; the job's 20 minute timeout covers it.

## CI Failure-Rate and Step-Duration Measurement

`scripts/ci/measure-ci.sh` turns the ad-hoc "how flaky is this job / how long
does that step take" analysis into a reproducible command (issue #4122). Over a
bounded window of workflow runs it reports per-job outcome tallies ranked by
failure rate, per-step duration percentiles (min / median / p90 / p95 / max),
and the rerun-success rate — a job that failed and then passed unchanged on a
later attempt of the same head SHA.

```bash
scripts/ci/measure-ci.sh --limit 60                    # human summary
scripts/ci/measure-ci.sh --limit 100 --json > win.json # diffable JSON
scripts/ci/measure-ci.sh --limit 100 --cache /tmp/ci.json  # resumable fetch
```

Two properties matter and are pinned by `test/bats/measure-ci.bats`:

- **Repeated steps keep their ordinal.** A job that boots a simulator three
  times reports `Boot #1`, `Boot #2`, `Boot #3` separately. Grouping by name
  alone destroys the signal that justified dropping the Xcode 26.2 leg
  ("all 9 boots >= 300s were the _third_ boot").
- **Percentiles are nearest-rank**, not interpolated: `index = ceil(p/100 * n)`.

The script is two separable layers. `--fetch-only` emits the normalized bundle
JSON from the Actions jobs API; `--from-file` aggregates a pre-fetched bundle
with no network access at all, which is how the BATS suite drives it. Step
conclusions and timestamps come from the structured jobs API; the only log-text
path is the opt-in `--sentinel` / `--sentinel-job` pair, for strings that appear
solely in job output (e.g. `Status=4294967295`).

`--limit` is bounded by `--max-runs` (default 200) and exceeding it is a loud
error rather than a silent truncation. `gh api --paginate` over workflow runs is
deliberately avoided — it hangs and returns nothing; pages are requested
explicitly with a cap.

## Startup Benchmark

Measure MCP server and daemon startup time (cold/warm) with optional baseline comparison:

```bash
bun run benchmark-startup --compare benchmark/startup-baseline.json --output reports/startup-benchmark.json
```

**Options:**

```bash
# Only run cold or warm measurements
bun run benchmark-startup --cold
bun run benchmark-startup --warm

# Skip daemon or server benchmarks
bun run benchmark-startup --server-only
bun run benchmark-startup --daemon-only

# Stream benchmark stdio as it is read
bun run benchmark-startup --verbose

# Change regression threshold multiplier
bun run benchmark-startup --threshold 1.3
```

**Notes:**

- Device discovery scenarios run only when `adb` is available and at least one device is connected.
- The benchmark will run `adb kill-server` when measuring cold ADB startup impact.

## NPM Unpacked Size Benchmark

Measure and enforce the NPM unpacked size threshold for the root package:

```bash
bun run benchmark-npm-unpacked-size --output reports/npm-unpacked-size.json
```

**Options:**

```bash
# Use custom threshold configuration
bun run benchmark-npm-unpacked-size --config path/to/thresholds.json

# Output JSON report to file
bun run benchmark-npm-unpacked-size --output reports/npm-unpacked-size.json
```

**Notes:**

- Runs `prepublishOnly` before packing to match the published package contents.
- Explicitly enables bundled-dependency trimming locally and in CI; the size cap assumes trimmed contents.
- Always reports remaining headroom in bytes and as a percentage of the cap, rounded to one decimal (zero for a non-positive cap).
- Passing sizes with less than `warnHeadroomBytes` (1 MiB by default) remaining emit a warning without failing the check. Exactly at the cap still passes; exceeding it or violating packed-asset requirements fails.
- Warnings and failures list the 10 largest packed files, ordered by size descending and path ascending for ties. JSON reports include the same diagnostics for the PR summary.
- Requires a prior `bun run build` so `dist/` is present.

## Manual Device Benchmark: Observe Screenshot Modes

Measure the latency of `observe` with `screenshot: "async"`, `"settled"`, and
`"none"` on a connected emulator or simulator. This informs the latency choice
for issue #8042 PR 2 (using `observe({ screenshot: "settled" })` for fresh screenshots). The script also measures a
`pressButton volume_up` action probe under the server's ambient screenshot
default; volume keys do not change app or window state. `pressButton` does not
accept a screenshot mode, so this action sample is not mode-controlled.

```bash
bun run bench:settled-screenshot --platform android --iterations 30
bun run bench:settled-screenshot --platform ios --iterations 30
# Or target a specific device identifier
bun run bench:settled-screenshot --device <device-id> --app <bundle-or-package>
```

Options include `--warmup W` (default 3), `--iterations N` (default 30),
`--server <path>`, `--json`, and `--allow-failures`. The server entry must exist;
otherwise the script fails before creating a child or temp directory with
`run "bun run build" first`. A timestamped full JSON report is always saved
under `scratch/` after measurements; `--json` selects JSON for console output.
Failed measured iterations, including thrown tool errors, have deduplicated
messages and counts in JSON and a "Failure reasons:" section under the table.
JSON retains full messages; table messages are flattened and truncated to 200
characters. Partially failed series retain their measured latency percentiles.
An all-failed series is `INVALID`, has no JSON latency percentiles, and is
excluded from settled-versus-async deltas. It exits with status 1 unless
`--allow-failures` is passed; the report is still written and printed.

This is manual only and is never run in CI or fast gates. Each MCP stdio child
gets a full private daemon namespace in a unique short `am-bench-` directory
under the OS temp directory: lifecycle socket/PID/lock, auxiliary and WebRTC
sockets, data, logs, database, and launch working directory. Conflicting DB
settings and legacy aliases are removed from the child's environment; the
parent environment stays unchanged. Each run selects an OS-assigned ephemeral TCP
port by briefly binding port zero on `127.0.0.1`; the child receives
`--port N --strict-port`, so an intervening bind fails rather than falling back
to the resident daemon's 3000..3010 range. A shared guard verifies the exact
private paths, rejects resident/default locations and ports, and checks exact
argv before either MCP launch or namespace-scoped `--daemon stop` cleanup.
The script refuses to target the resident daemon. Cleanup closes MCP, stops
the private daemon, then removes the run directory. A failed or timed-out stop
logs a warning and retains the directory and PID record for the operator;
cleanup errors do not replace the primary error. SIGINT/SIGTERM share the same
idempotent cleanup and exit with status 130/143. Stop waits are bounded at 30
seconds without signalling any process.

Private-namespace start/stop scopes ownership to that run (#8762). The guard
cannot change daemon-manager internals: its degraded process-table probe still
includes the default port 3000 and may encounter a resident daemon.
A private daemon startup failure is reported like any other failed call, with
its error message in JSON and the table; an all-failed series is INVALID and
exits non-zero unless `--allow-failures` is passed.
`AUTOMOBILE_COORDINATION_DIR` remains inherited: device coordination is shared,
not a daemon selector. The fresh private data directory can require fetching
CtrlProxy/video assets again. `pressButton volume_up` is valid on both Android
and iOS simulators since #8370; no platform special case is needed. The probe
changes device volume and optional `--app` launches the specified app.

## Live Check: Device-Session Idle Release

`live-idle-release-check.sh` (#10671) checks the device-session release windows
against one real emulator. It never runs in CI or fast validation.

```bash
bun run build
bash scripts/live-idle-release-check.sh --confirm-live --serial emulator-5560 --port 3920
```

It starts a private daemon whose socket, pid, lock, aux sockets, data, logs,
database, coordination and iOS cache directories all live in one `/tmp/am-idle.*`
directory. The daemon runs on the explicit `--port` with `--strict-port`, and
`AUTOMOBILE_SESSION_IDLE_TIMEOUT_MS` is set to `--idle-timeout-ms` (default
20000). Inherited daemon, database and session-timing variables are dropped. The
script refuses ports 3000-3010 and any serial that is not `emulator-NNNN`.

A stdio proxy acquires the emulator with `getAndroid`. The script then checks
three scenarios:

- **active**: the device stays held past the idle window while the proxy
  heartbeats and makes control calls (`homeScreen`). Reads such as `observe`
  are not activity (#10964).
- **no-heartbeat**: the proxy is suspended with SIGSTOP, so its socket stays open.
  The device must be released within about 10 s.
- **idle**: the proxy heartbeats but makes no calls. `lastOwnerHeartbeatAt` must
  advance while `lastToolActivityAt` stays put, and the device must be released
  once the idle window passes, with the proxy still alive.
- **observe-only**: the owner only calls `observe {deviceId}`. `lastToolActivityAt`
  must not move, and the device must be released at the idle window.

Each scenario reads `--daemon active-sessions` and also requires `holderKind` to
be `stdio-proxy`. Afterwards `adb get-state` must still answer, since release
never kills the device. The `active-sessions` snapshots and the daemon log lines
that name the session are saved under `scratch/live-idle-release-check/<time>/`.
On failure the private directory is kept. `test/bats/live-idle-release-check.bats`
covers the script with a fake server, adb and clock.

## Other Scripts

### Build Scripts

- `build.ts` - Compile TypeScript to JavaScript for distribution
- `npm/transform-readme.js` - Transform README for npm package

### Local Development Scripts

- `local-dev/android-hot-reload.sh` - Unified Android development workflow with APK hot-reload, MCP server, and AI assistant integration
  - `--skip-ai` - Run without AI prompt
  - `--once` - Build/install once and exit
  - `--update-checksum` - Update release.ts with APK checksum
  - Shared functions in `local-dev/lib/` (common.sh, adb.sh, apk.sh)
- `local-dev/ios-hot-reload.sh` - Unified iOS development workflow with XCTestService hot-reload, MCP server, and AI assistant integration
  - `--skip-ai` - Run without AI prompt
  - `--once` - Build once and exit
  - `--device <udid>` - Target a specific booted simulator
  - Shared functions in `local-dev/lib/` (common.sh, deps.sh, xctestservice.sh)

### Tool Definition Scripts

- `update-tool-definitions.sh` - Regenerate and stage `schemas/tool-definitions.json` for IDE YAML completion

### Validation Scripts

See individual script directories for specialized validation:

- `docker/` - Docker container testing
- `ide-plugin/` - IntelliJ/Android Studio plugin validation
- `ktfmt/` - Kotlin formatting
- `lychee/` - Documentation link validation
- `shellcheck/` - Shell script linting and formatting
- `xml/` - XML validation and formatting

Root-level validation scripts:

- `validate_codex_skills.sh` - Validate `skills/*/SKILL.md` metadata, optional `agents/openai.yaml` interface metadata (colocated with both the canonical skill and the discoverable `.agents/skills/<name>` wrapper, since Codex reads metadata next to the wrapper it discovers), `.agents/skills` Codex discovery wrappers, and `AGENTS.md` inventory consistency
- `validate_dependabot.sh` - Validate Dependabot config YAML
- `validate_mkdocs_nav.sh` - Validate MkDocs nav configuration

Run `scripts/<category>/validate_*.sh` for validation or `scripts/<category>/apply_*.sh` for auto-formatting.

#### Unit-test host-spawn guard

A unit test may not launch a host process. The Bun preload
(`test/setup/realDeviceToolSpawnGuardPreload.ts`, listed in `bunfig.toml`) replaces
`Bun.spawn`, `Bun.spawnSync` and `Bun.$`; on Bun 1.3.14 every `node:child_process`
launcher (`spawn`, `spawnSync`, `exec`, `execSync`, `execFile`, `execFileSync`,
`fork`) reads those two properties at each call, including through bindings
imported before the preload ran, so they are covered without a patch of their own.
A launch from a unit test file throws an error naming the file, the command line
and the frames that launched it, unless
`scripts/unit-test-host-spawn-allowlist.txt` lists that file with that command.

Inject a fake first (`FakeProcessExecutor`, a fake adb executor,
`FakeDisplayInventoryProvider`, `PlatformDeviceManagerFactory.setInstance`). List
a launch only when the test is about the real tool and the tool is local and
harmless (`git ls-files`, a script under `scripts/`, a fixture run with `bun`).
Each entry is `<unit test file> <command>` under a comment saying why;
`test/lint/unitTestHostSpawnAllowlist.test.ts` checks the file.

Never allow-listable, refused even when listed: `adb`, `xcrun`, `xcodebuild`,
`simctl`, `devicectl`, `emulator`, `avdmanager`, `sdkmanager`, `ffmpeg`, `curl`,
`defaults`, `gsettings`, `auto-mobile`, and any launch whose arguments name the
resident daemon's `/tmp/auto-mobile-daemon-<uid>.{sock,pid,lock}` files. So are the
wrappers the guard cannot see through (`sudo`, `doas`, `xargs`, `script`,
`osascript`, `stdbuf`, `setsid`, `eval`, `open`). These are found by executable
name (any directory, `.exe`/`.cmd`/`.bat` stripped, any letter case), in
`which`/`where` lookups, and inside simple shell commands
(including `;`, `&&`, `||`, and `|` segments). The guard unwraps
`sh`/`bash`/`zsh`/`dash -c`, `cmd /c`, `env`, `exec`, `command`, `timeout`, `nice`,
`nohup`, and leading `NAME=VALUE` assignments; shell tokenization preserves
single/double quotes and backslash escapes, including quoted assignment values.
`env` short clusters honor operand-taking options, including attached/separate
`-S` split strings. Unbalanced quotes or command substitutions use a conservative
scan for exact guarded executable tokens: `echo "adb"` is allowed, but
`echo "$(adb devices)"` and `echo "unbalanced adb` are blocked. This fallback can
reject inert arguments in unsupported syntax; it does not block substrings such as
`myadb`. Inside a shell string it does not look behind `eval`, `xargs`, or reserved
words such as `if`, `then`, `do`, `!` and `{`: treat a listed `sh` or `bash` as
trusted text and read what the test passes to it.

Swallowed errors during a test still fail that test via a scoped `afterEach`
drain. Import/setup/late launches receive one synthetic `afterAll` failure per
offending file; their reports do not fail subsequent tests.

Shared-process runs (for example, `bun test test/server`) attribute each launch
using a retained test-file stack frame, falling back to `Bun.main` read at launch
time (Bun 1.3.14 updates it per file; `process.argv[1]` stays fixed). Detached
work with no retained test frame can only be attributed to the current runtime
file; swallowed runtime-only violations use the once-per-file backstop rather than
failing every subsequent test. A launch behind a process-wide cache is attributed
to whichever file reaches it first, so it cannot be allow-listed per file: give it
a suite-wide default in `test/setup/testPreload.ts` instead (as the daemon's
process generation token has).

Outside this guard:

- Integration (`*.integration.test.ts`) and stress files, classified per launch.
- Windows: interception stays disabled until that process boundary is verified
  (`cmd` classification is unit-tested).
- What an allowed child does: a listed `bash script.sh` or `bun fixture.ts` runs
  unguarded, and so do its own children. Review an entry as if it were the script.
- `new Bun.$.Shell()`: Bun defines `$.Shell` non-configurable and non-writable, so
  it cannot be replaced. Nothing in the repository uses it.
- Functions captured from `Bun` before the preload ran, `Worker` threads (they do
  not load the test preloads), `bun:ffi`, and shell syntax beyond the bounded
  tokenizer above.
- A daemon socket handed to a child through its environment instead of its
  arguments.
- Anything that is not a process launch: a test can still open a TCP connection to
  the adb server or a socket to a daemon. `test/helpers/inMemoryDaemonWire.ts`
  (`assertNotHostDaemonPath`) and the fixed-port fetch guard cover those paths.

To take an inventory, set `AUTOMOBILE_SPAWN_GUARD_CENSUS_FILE=<path>` on a
`bun test <explicit files>` run: every launch from a unit test is appended as
`<file>\t<command>\t<ran|refused>\t<argv JSON>`. Listable commands run; the
never-allow-listable ones are refused with an ENOENT-coded error instead of a
violation. Run it with `--isolate` (in chunks of files, not one long process) to
see the launches a shared process hides behind caches.
`AUTOMOBILE_SPAWN_GUARD_ALLOWLIST` overrides the allow-list path for fixture runs.
Never inject preloads through `BUN_OPTIONS` or route a census through `test-ts.sh`.

### iOS Video Recording Integration

Run the real iOS simulator `videoRecording` start -> stop regression test:

```bash
scripts/ios/video-recording-start-stop-integration.sh
```

The script uses an already booted iPhone simulator when available, otherwise it uses AutoMobile product boot. It requires `bun`, `xcrun`, `jq`, `ffmpeg`, and `ffprobe`, records for `AUTOMOBILE_IOS_VIDEO_RECORDING_WAIT_MS` milliseconds when set, and fails if the finalized `.mp4` is missing, empty, unreadable, or lacks a video stream.

## Artifact Qualification

- `qualification/caseResult.ts` - Strict Zod case-result format, proof levels, sanitized fixture IDs and supported boundaries. Generate `case-result.schema.json` with `--write`; `--check` exits 1 on drift, 2 on usage error.
- `qualification/runCase.ts` - `bun run qualify:run-case` records a reproducible command, elapsed operation timing, identity fields and evidence hashes. Requires metadata, `--out` and `-- <command...>`; `--not-exercised --boundary <text>` records a gap without spawning. Exits with the command's status, or 2 on usage error.
- `qualification/aggregateResults.ts` - `bun run qualify:aggregate --results <dir> [--identity <file>] [--markdown <out>] [--require-pass]` validates non-recursive JSON cases and renders separate native, injected-fault, deterministic-test and gap tables. Rejects duplicate cases/mixed artifacts and warns on timing overruns; exits 1 on validation errors or required fail/blocked outcomes, 2 on usage error. See [Managed-slot qualification](../docs/using/managed-slot-qualification.md).
- `release/write-build-info.ts` - Runs at `prepack`; writes reproducible source SHA, tracked-file dirtiness, package version, and native-resource checksum pins to `dist/build-info.json`. Skips with a warning when `dist/` is absent.
- `qualification/artifactIdentity.ts` - Identifies an installed or extracted package, refuses source checkouts and mismatched expected SHAs, checks packed assets and native pins, and records the published managed-slot contract. Run `bun run qualify:identity --package-dir <dir>`; optional flags: `--tarball <tgz>`, `--expected-integrity <sri>`, `--repo <dir>`, `--expect-source-sha <sha>`, `--native-assets-dir <dir>`, `--out <file>`. Emits JSON plus checks on stderr; exits 0 identified, 1 refused, 2 usage error. Published-package proof requires matching expected tarball integrity and directory contents (extra node_modules files allowed).

## CI Integration

The following scripts are invoked by GitHub Actions workflows:

- `benchmark-context-thresholds.ts` - Runs in `.github/workflows/merge.yml`
- `benchmark-startup.sh` - Runs in `.github/workflows/pull_request.yml`
- `measure-cold-imports.sh` - Advisory cold-import timing (median/min/max ms, module count) for slow action suites; runs non-failing on Linux in the `ts-build-and-test` job of `.github/workflows/pull_request.yml`
- `benchmark-npm-unpacked-size.ts` - Runs in `.github/workflows/pull_request.yml`
- `validate_*.sh` - Various validation workflows in `.github/workflows/pull_request.yml`

See workflow files for integration details.

## Development

All scripts should:

- Include usage instructions in header comments
- Return appropriate exit codes (0 for success, non-zero for failure)
- Provide clear error messages
- Be executable directly (have shebang and execute permissions)

### Adding New Scripts

1. Place script in appropriate subdirectory (or create new one)
2. Add shebang line (`#!/usr/bin/env bun` for TypeScript, `#!/usr/bin/env bash` for shell)
3. Include header documentation with usage examples
4. Make executable: `chmod +x scripts/your-script.ts`
5. Add npm script alias if appropriate (in `package.json`)
6. Document in this README
7. Update `.github/workflows/` if CI integration needed

## Android prototype performance

- `scripts/android/compose-compiler-report.sh` — opt-in release compiler reports, package stability summary, and generated Compose compiler report pages.
- `scripts/android/prototype-frame-benchmark.sh` — explicit-device gfxinfo scenarios for the fixed benchmark prototype; supports command-only dry runs and stub executables.

See [prototype performance measurement](../docs/design-docs/plat/android/prototype-performance-measurement.md) for prerequisites and output formats.

### Manual Linux Qualification

`.github/workflows/linux-qualification.yml` is dispatch-only; it never runs on
push, pull request, or a schedule. No workflow is dispatched during development.
`scripts/ci/linux-qualification/capture-proc-fixtures.sh <outdir>` captures real
Alpine/Debian procfs bytes and a reproducible command/digest manifest (#11998).
`scripts/ci/linux-qualification/emulator-cell.sh` runs the 4 GPU × 3 workload
experiment (#12453), using `scripts/ci/linux-qualification/lib.sh` for bounded
operations and injectable `NOW_CMD` / `SLEEP_CMD` clocks. The load drivers are
`scripts/ci/linux-qualification/workload-automobile.sh`,
`scripts/ci/linux-qualification/workload-raw-adb.sh`, and
`scripts/ci/linux-qualification/workload-heartbeat.sh`.
`scripts/ci/linux-qualification/classify-exit.sh <evidence-dir>` consumes timestamped
harness evidence; `scripts/ci/linux-qualification/summarize.sh <artifact-dir>`
produces three outcome lists, missing-cell coverage, and the experiment decision
table offline. Tests are the three `test/bats/linux-qualification-*.bats` files.
Defaults: 300 seconds, one cycle, 600-second boot bound, 4800-second cell budget measured from the first post-checkout step;
reserve another 180 seconds for shutdown/evidence. Heartbeats allow 2 seconds of
scheduling lateness and must return within 4 seconds. W and C run a serial
Settings cold-launch/search-tap/text-and-enter/screenshot sequence with a one-second pause; H polls
only get-state every five seconds. C uses tap (200,150), overridable by TAP_X/Y;
W resolves the Settings “Search settings” label. These exercise the same
operation cadence, but transport/selector latency and target coordinates differ.
Each cycle cold boots (snapshot load/save disabled) with a fresh private daemon
namespace for W. Host GPU boot refusal is UNEXERCISED. A crash is data and emits
a warning; harness errors fail the cell. Inputs accept up to nine decimal digits. No runtime stability claim is made from
one passing cycle. The artifacts can be large because cores and full logs are kept.
