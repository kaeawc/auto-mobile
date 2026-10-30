# Agent benchmarks

The agent benchmark runs Claude Code against the AutoMobile MCP server on a real Android device,
gives it a task in the Playground app, and audits the run: did the agent finish the task, how
many tool calls and turns it took, what it cost, where it stumbled, and how all of that compares
with a recorded baseline. It is modelled on MobileBuildMCP's (formerly XcodeBuildMCP)
`benchmarks/claude-ui` harness.

It is operator-run only. Each run launches Claude (real API cost) and drives a device, so it is
never part of the unit suite or PR CI. The harness's own logic is covered by fast unit tests under
`test/scripts/agentBenchmark/`.

## Quick start

1. Boot one Android emulator and install a debug build of the Playground app
   (`(cd android && ./gradlew :playground:app:installDebug)`), or set `app.apkPath` in the suite.
2. Make sure `claude` is on `PATH` and signed in.
3. Run a suite:

```bash
bun run bench:agent -- --suite bug-repro
```

`bench:agent` builds first, because the MCP server runs from `dist/src/index.js`. To skip the
build, call the script directly. A run still refuses a `dist/src/index.js` older than any file in
`src/` or `schemas/tool-definitions.json`, since the device-use check classifies tools from the
sources while the run executes the build:

```bash
bun scripts/agent-benchmark/run.ts --suite bug-repro
bun scripts/agent-benchmark/run.ts --all
bun scripts/agent-benchmark/run.ts --all --dry-run       # validate suites, print the claude command
bun scripts/agent-benchmark/run.ts --suite ux-flow --model claude-sonnet-5-5 --json
bun scripts/agent-benchmark/run.ts --from-result scratch/agent-benchmarks/bug-repro/20261016T010203Z-1a2b3c4d
```

| Option                             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--suite <name\|path.yml>`         | Run a committed suite by name or any suite file by path (repeatable).                                                                                                                                                                                                                                                                                                                                                                |
| `--all`                            | Run every suite in `benchmark/agent/suites/` (not combinable with `--suite`).                                                                                                                                                                                                                                                                                                                                                        |
| `--device <serial>`                | Assert which device is the target. Exactly one online device is always required.                                                                                                                                                                                                                                                                                                                                                     |
| `--model <model>`                  | Override the suite's `claude.model` for a controlled comparison.                                                                                                                                                                                                                                                                                                                                                                     |
| `--server-instructions`            | Turn on the server's MCP instructions block for this run, to compare runs with and without it.                                                                                                                                                                                                                                                                                                                                       |
| `--json`                           | Print the full result JSON instead of the text report.                                                                                                                                                                                                                                                                                                                                                                               |
| `--dry-run`                        | Validate suites and print the Claude command and MCP config; touches no device or API.                                                                                                                                                                                                                                                                                                                                               |
| `--from-result <dir\|result.json>` | Re-render an earlier run without re-running Claude.                                                                                                                                                                                                                                                                                                                                                                                  |
| `--claude <command>`               | Claude Code executable (default `claude`). Claude runs in its own process group, so a timeout, Ctrl+C, or the wrapper's exit stops a wrapper script and everything it started. On Windows, `--claude` must be an executable (the native `claude.exe`), not a `.cmd`/`.bat` script such as npm's `claude.cmd`, and a wrapper must wait for Claude: if it exits while Claude keeps running, the harness cannot find Claude to stop it. |
| `--output <dir>`                   | Artifact root (default `scratch/agent-benchmarks`).                                                                                                                                                                                                                                                                                                                                                                                  |

The exit code is `0` when every run passed, `1` when any run failed or was incomplete, and `2`
for a usage error.

## What a run does

1. **Preflight (not measured).** Resolves the device, optionally installs the APK, and records the
   installed app build (`versionName`, `versionCode`, `lastUpdateTime`) so results from different
   builds are never mistaken for comparable. It then force-stops the app, clears its data, seeds
   SharedPreferences, deep-links to the suite's start screen, and waits `settleSeconds`.
2. **Claude run (measured).** Spawns `claude -p --output-format stream-json` from an empty temp
   directory, with the prompt on stdin. `wallClockSeconds` covers only this step.
3. **Post-run (not measured).** Dumps the device screen with `uiautomator` when the suite has
   screen checks, then stops the run's private daemon.
4. **Audit.** Parses the transcript, scores the checks, compares against the baseline, and writes
   `result.json`.

### Isolation

Each run isolates the local state below so earlier runs and your own Claude Code setup do not
leak into it. Provider, proxy, and model-routing settings are kept on purpose (see below), so
they can still affect results:

- `--strict-mcp-config` with a generated config: only the auto-mobile server is available.
- Claude runs from an empty temp directory outside the repository. Claude Code loads `CLAUDE.md`
  from its working directory and every parent, so running from anywhere inside the checkout
  (including `scratch/`) would still pull in this repository's `CLAUDE.md` and skills.
- `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_POLICY_SKILLS=1` are always set, so
  your own `~/.claude/CLAUDE.md`, auto-memory, and any organization-managed skills on the host
  don't shape the run, and `--setting-sources project,local` skips your user settings,
  so your hooks and enabled plugins don't apply either. (`--bare` would do this too, but it
  requires API-key auth and would break subscription sign-in.) Organization-managed settings
  files still apply at the highest precedence, so each one present on the host (under
  `/etc/claude-code`, `/Library/Application Support/ClaudeCode`, or `ClaudeCode` in
  `Program Files`/`ProgramData` on Windows) is digested into the build fingerprint; settings
  delivered by server or MDM profile aren't visible as files and aren't covered. Two operators get
  comparable results for the same suite and model.
- Inherited Claude Code variables that change run behavior are removed from Claude's
  environment: effort and thinking, subagent model and limits, turn and output caps, context
  and compaction, Bash and MCP limits and timeouts, retries, tool search, and extra `CLAUDE.md`
  directories (for example `CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_SUBAGENT_MODEL`,
  `CLAUDE_CODE_MAX_TURNS`, `MCP_TOOL_TIMEOUT`), plus the prompt-caching switches
  (`DISABLE_PROMPT_CACHING*`, `ENABLE_PROMPT_CACHING*`, `FORCE_PROMPT_CACHING*`) and every
  `CLAUDE_*`, `API_*`, `MCP_*`, or `BASH_*` timeout or watchdog override (`API_TIMEOUT_MS`,
  `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS`, ..., and the `CLAUDE_*WATCHDOG*` toggles) and API beta control (`ANTHROPIC_BETAS`,
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`). The full list is `RUN_SHAPING_CLAUDE_VARIABLES` and
  `isRunShapingClaudeVariable` in `scripts/agent-benchmark/invocation.ts`. Auth, provider,
  and proxy variables are kept, including `ANTHROPIC_MODEL`, which Bedrock and Vertex need; the
  observed model is recorded in every result.
- The server uses a **private daemon** (`AUTOMOBILE_AUX_SOCKET_DIR`), a **fresh database**
  (`AUTOMOBILE_DB_DIR`, so no learned navigation graph carries over), its own data directory
  (`AUTOMOBILE_DATA_DIR`, `<run>/data`, for caches and temp files), and its own log directory
  (`<run>/logs`). Device claims and coordination ignore the data directory and stay shared.
  `NODE_ENV` is not inherited, so a `bun test` parent cannot arm the server's test-only guards.
  Every AutoMobile variable inherited from your shell (`AUTOMOBILE_*` and the
  legacy `AUTO_MOBILE_*` names) is removed first. Otherwise a state override such as
  `AUTOMOBILE_DB_PATH` would win over the run's values, and a setting such as
  `AUTOMOBILE_DISABLED_TOOLS` would quietly change the agent's toolset. The one exception is
  `AUTOMOBILE_ADB_SERVER_COORDINATION_DIR` (and its legacy `AUTO_MOBILE_` spelling), kept so a
  resident daemon's device claims are still respected. It is also written into the MCP config's
  `env`, with the adb endpoint (`ADB_SERVER_SOCKET`, `ANDROID_ADB_SERVER_ADDRESS`,
  `ANDROID_ADB_SERVER_PORT`) and SDK location (`ANDROID_HOME`, `ANDROID_SDK_ROOT`), made absolute like the claim root since the server runs from a temp directory, so the server
  reaches the same adb server. `CLAUDE_CODE_MCP_ALLOWLIST_ENV` is removed from Claude's
  environment, so the server also inherits `PATH` and runs the same `adb` the run was
  fingerprinted against. Before preflight touches the device,
  the harness runs the same ownership check daemons use (forwarding lease, current and legacy
  claims, unreadable claims, live CtrlProxy forwards) and refuses a device another AutoMobile
  session holds. It then holds the device's allocation claim itself through preflight, so a
  concurrent daemon is refused rather than racing `pm clear`, and hands it over just before Claude
  starts so the run's own daemon can claim it. If that claim cannot be written, the run stops
  instead of continuing unprotected. A separate benchmark-only lock
  (`<claim file>.agent-benchmark`) is held for the whole run, so a second benchmark on the same
  device is refused even after the handover; a crashed benchmark's lock is reclaimed. When Claude
  exits, the harness stops the run's daemon and takes the allocation claim back before the post-run
  screen dump. If another session claimed the device in between, the screen is not read and the
  screen check fails.
  **Known gap:** the benchmark-only lock is honored only by benchmark runs. Between the handover and
  the run's first device tool call, nothing stops an ordinary AutoMobile daemon you have running
  from claiming the device, changing it, and releasing it again. The start-screen check runs before
  the handover, so it cannot see this. Stop other AutoMobile sessions on the device before a run whose
  result will become a baseline. Closing the gap needs an ownership transfer that every daemon
  honors, which is a daemon change outside this harness.
- No iOS simulator may be booted and no physical iOS device connected (checked with
  `xcrun simctl` and `devicectl` on macOS): the benchmark's AutoMobile server discovers iOS too,
  which would make device selection ambiguous. If either check itself fails on macOS, the run stops
  rather than assuming none.
- The device's foreground user must be the primary user (0): preference seeding with `run-as`
  targets user 0 while the launch targets the current user, so another user would start an
  unseeded app.
- Exactly one Android device must be online. Nothing pins the MCP server to a serial, so with
  several online the agent could act on a device other than the one prepared and verified.
- `Bash` and `PowerShell` are always disallowed (and `CLAUDE_CODE_USE_POWERSHELL_TOOL` is removed
  from Claude's environment), so the agent cannot fall back to raw `adb`. A suite can disallow
  more tools: `ux-flow` also blocks `openLink`, `navigateTo`, and `executePlan` (which can run a
  nested `openLink`), because the task is to navigate by tapping.

## Verdicts

A run's verdict comes only from hard signals; baselines never change it.

| Verdict      | Meaning                                                                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `passed`     | Claude exited 0, the MCP server connected, the stream ended in a successful `result`, the transcript parsed cleanly, and every `verify` check passed.                                              |
| `failed`     | The run completed, but a check failed: Claude made no successful device-aware auto-mobile tool call, or the final answer or the device screen did not show the expected text.                      |
| `incomplete` | The process timed out or exited non-zero, the MCP server did not connect, the `result` event is missing or an error (for example `error_max_budget_usd`), or the transcript has unparseable lines. |

Every suite must have at least one `verify.screenIncludes` entry: the device screen is the oracle,
since an answer alone can be produced without touching the app. `verify.answerIncludes` checks Claude's final reply, case-insensitively. Each expected string
must stand alone: it can't run on into a letter or digit in any script, so `EXPECTED_COUNT: 3`
doesn't match `EXPECTED_COUNT: 30` (or `3.5`, or `3,000`) and `完了` doesn't match inside `未完了`. Expected `KEY: value` strings (a word, then a colon, in any case) must be the reply's last nonblank lines (code fences aside), each exactly one expected line apart from case, spacing, backticks, and a trailing period, in the suite's order, so a reply that reports a different value, adds text to the line, or adds a disclaimer after it fails. A run must also make at
least one non-error call to a device-aware auto-mobile tool (one whose generated schema takes a
`device` label); inventory and control tools such as `listDevices` and `setToolEnabled` don't count,
so an answer produced without touching the device fails. Suite prompts ask for a fixed final-line format so this is deterministic. `verify.screenIncludes` checks an independent
`uiautomator` dump taken after Claude exits. It matches only the `text` and `content-desc` of the
suite app's own nodes, so resource ids, class names, and other packages' windows can't satisfy it.
This is the oracle that catches an agent that _reports_ success without achieving it.

**Stumbles** are tool results with `is_error`, failure-pattern matches in tool results, and
permission denials. They are reported, not scored.

## Suite format

Suites live in `benchmark/agent/suites/*.yml`, and prompts in `benchmark/agent/prompts/*.txt` (not `.md`: CI treats a Markdown-only change as docs and skips the tests that load suites, so `loadSuite` rejects a `.md` prompt).
Unknown keys fail validation, so a typo cannot silently change what a run measures.

```yaml
name: bug-repro # must match the file name
platform: android
prompt: ../prompts/bug-repro.txt # relative to this file
app:
  packageName: dev.jasonpearson.automobile.playground
  # apkPath: path/to/app.apk        # optional, relative to the repo root
preflight:
  clearAppData: true # default true
  sharedPreferences: # optional; written via run-as (debuggable builds)
    onboarding_prefs:
      onboarding_completed: true
  launchUri: automobile://playground/demos/bugs/repro
  settleSeconds: 2 # default 2
  startScreenIncludes: [] # optional; text the app must show before Claude starts
claude:
  model: claude-sonnet-5-5 # optional; --model overrides it
  appendSystemPrompt: "" # optional; {deviceSerial} {packageName} {runDirectory}
  allowedTools: [mcp__auto-mobile] # default
  disallowedTools: [] # Bash is always denied; entries here add to it
  maxBudgetUsd: 2 # optional hard spend cap per run
  timeoutSeconds: 600 # default 900
verify:
  answerIncludes: ["EXPECTED_COUNT: 3"]
  screenIncludes: ["Expected count: 3"]
failurePatterns: [] # substrings in tool results counted as stumbles
ignoredFailurePatterns: [] # results containing these are not stumbles
baseline: {} # optional; see below
baselineToolSequence: [] # optional
```

The prompt text supports the same `{deviceSerial}`, `{packageName}`, and `{runDirectory}`
placeholders. The harness always tells Claude which device serial and app to use.

Preference values are written with Android's typed tags. Integers must be safe JavaScript
integers. Fractions are stored as 32-bit floats, so a nonzero value too small for that type
(which would be stored as 0) is rejected.

Playground suites seed `onboarding_prefs` and `auth_prefs` after clearing data, because the app
redirects every Demos deep link to onboarding until onboarding is complete and the user is signed
in.

`preflight.startScreenIncludes` checks the screen after settling, using the same app-only text
match as `verify.screenIncludes`. If the expected text is missing (a changed preference
contract, or a deep link that redirected to onboarding), the run stops before Claude starts and
`<run>/start-screen.xml` shows where the app landed.

## Baselines

Baselines are comparison data, not pass/fail gates. Metric rows show the actual value, the
baseline, and the delta. The tool sequence is shown as a longest-common-subsequence diff (`−`
means a baseline call the agent skipped, `+` means an extra call). Real runs can take equally valid
paths, so sequence drift never fails a run.

When a run passes with no stumbles, the harness writes `<run>/baseline.yml`, which you can paste
into the suite. A run that recovered from a stumble still passes but writes no snippet, because its
error count and recovery calls would skew later comparisons. A suite with `clearAppData: false`
never writes one either, since state left by earlier runs makes its starting point unreproducible.
Record baselines only from clean, passing runs. When establishing one, allow up to three
attempts. If none passes, leave the suite without a `baseline` block rather than recording a
failed run.

The snippet also records the app build fingerprint (`baseline.appBuild`): `versionName`,
`versionCode`, and either the installed `lastUpdateTime` or, when the suite sets `app.apkPath`, a
SHA-256 prefix of the APK (preflight reinstalls it every run, which resets the install time). If a
later run's installed app differs, the report flags that its deltas compare different app builds.
With `app.apkPath`, preflight also checks that the installed base APK has the same SHA-256, so an
APK built for a different package fails the run instead of benchmarking a stale app. If the
device cannot hash the installed APK (no `sha256sum`), preflight also stops; install the app
yourself and remove `app.apkPath` to run without the check.

It also records `baseline.suiteDigest`, a digest of the prompt, every suite setting other than
the baseline itself, and the requested model. If the prompt, preflight, tool permissions, failure
patterns, or timeout change, the report flags that the baseline measured a different task.
It also records `baseline.deviceFingerprint` (SDK level, model, locale, effective screen
size and density, font and animation scales, light or dark theme, enabled accessibility
services such as TalkBack, navigation mode (gesture or buttons), the active input method (keyboard), time zone, 12/24-hour clock setting, Android build ID, and live rotation, since hierarchy shape and timing depend on them), `baseline.claudeCodeVersion` (CLI releases change system prompts and
tool handling), `baseline.serverBuild` (a SHA-256 prefix over what executes and scores the run: the
built `dist/` with the schemas and vendor tools it loads at runtime, `bun.lock` for the image
libraries the build leaves external, `package.json`, the harness sources under
`scripts/agent-benchmark/` with every repository module they import (they run unbundled), the
Bun version, and the host platform, architecture, and libc (which pick the native image build), the `--claude` command (by content, so an edited wrapper or binary counts), and a non-secret provider identity
(provider selection, the scheme and host of every provider base URL, AWS SDK endpoint override, and proxy with a digest of each path, digests of the account and project selectors (Vertex and Google Cloud project, the identity fields of the `GOOGLE_APPLICATION_CREDENTIALS` file, AWS profile, assumed role ARN, and access key ID, and the Anthropic workspace IDs, digests of `ANTHROPIC_CUSTOM_HEADERS` and of any proxy or base-URL credentials, plus the name (never the value) of whichever direct credential is set: API key, auth token, or OAuth token, and for an AWS provider a digest of the AWS config file the profile resolves through), proxy bypass list, regions, provider-specific region routing and service tiers, adb server endpoint, and model-routing variables), the `adb version` of every adb client the server might run (SDK platform-tools, the adb on PATH, and the SDK the server's command-line tools detection finds), so a change to whichever one the server picks changes the build; the harness runs the client the server picks (it resolves adb with the server's own AdbClient) for preflight and the screen oracle, and fingerprints its version too. A stale build or changed scoring code is
flagged rather than silently measured. The git commit is deliberately left out, since every
unrelated commit would change it), and
`baseline.observedModel`, the model Claude reported running. Suites without
`claude.model` use whatever model your environment selects, so a run on a different model is
flagged too. A fingerprint that could not be read (`unknown`) never counts as a match. If the
device, app build, Claude Code version, or observed model is unknown, the run writes no `baseline.yml` at all, because a
baseline missing them could never flag a later run on a different device, build, or CLI. The Claude Code version comes from the stream's init event, which names the CLI that
actually ran; `claude --version` is only the fallback when the stream reports none.

Suites have no free-form Claude flags. Any flag could undo run isolation (`--settings`,
`--resume`, `--plugin-dir`), so each supported option is its own typed `claude` field.

## Artifacts

Each run writes to `scratch/agent-benchmarks/<suite>/<timestamp>-<id>/`. The short random id keeps two
runs of the same suite that start in the same second apart.

| File                             | Contents                                                                  |
| -------------------------------- | ------------------------------------------------------------------------- |
| `prompt.md`                      | The exact prompt sent to Claude (placeholders filled in).                 |
| `mcp-config.json`                | The generated MCP config, including the private-daemon environment.       |
| `claude-command.json`            | The Claude command, arguments, and working directory.                     |
| `claude.jsonl` / `claude.stderr` | Claude's stream-json transcript and stderr.                               |
| `preflight.log`, `preflight/`    | Preflight steps and the staged preference files.                          |
| `screen.xml`                     | The post-run `uiautomator` dump (suites with screen checks only).         |
| `logs/`, `db/`, `data/`          | The private daemon's logs, database, and data directory.                  |
| `result.json`                    | The full result: run metadata, audit, checks, metrics, and sequence diff. |
| `baseline.yml`                   | A baseline snippet (passing runs with no stumbles only).                  |

## Adding a suite

Pick a Playground screen with stable text and a deep link (see
`android/docs/playground-deep-links.md`), and design a task with an end state you can read
back from the screen. Write the prompt so the final reply ends in fixed `KEY: value` lines, and
add both `answerIncludes` and `screenIncludes`. Run it with `--dry-run` first, then for real. The
unit test `config.test.ts` loads every committed suite, so an invalid suite fails fast locally.
