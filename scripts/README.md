# AutoMobile Scripts

This directory contains build, validation, and utility scripts for the AutoMobile project.

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
  ("all 9 boots >= 300s were the *third* boot").
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
- Requires a prior `bun run build` so `dist/` is present.

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

### iOS Video Recording Integration

Run the real iOS simulator `videoRecording` start -> stop regression test:

```bash
scripts/ios/video-recording-start-stop-integration.sh
```

The script uses an already booted iPhone simulator when available, otherwise it uses AutoMobile product boot. It requires `bun`, `xcrun`, `jq`, `ffmpeg`, and `ffprobe`, records for `AUTOMOBILE_IOS_VIDEO_RECORDING_WAIT_MS` milliseconds when set, and fails if the finalized `.mp4` is missing, empty, unreadable, or lacks a video stream.

## CI Integration

The following scripts are invoked by GitHub Actions workflows:

- `benchmark-context-thresholds.ts` - Runs in `.github/workflows/context-thresholds.yml`
- `benchmark-startup.sh` - Runs in `.github/workflows/pull_request.yml`
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
