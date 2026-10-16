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
   (`./gradlew -p android :playground:app:installDebug`), or set `app.apkPath` in the suite.
2. Make sure `claude` is on `PATH` and signed in.
3. Run a suite:

```bash
bun run bench:agent -- --suite bug-repro
```

`bench:agent` builds first, because the MCP server runs from `dist/src/index.js`. To skip the
build, call the script directly:

```bash
bun scripts/agent-benchmark/run.ts --suite bug-repro
bun scripts/agent-benchmark/run.ts --all
bun scripts/agent-benchmark/run.ts --all --dry-run       # validate suites, print the claude command
bun scripts/agent-benchmark/run.ts --suite ux-flow --model claude-sonnet-5-5 --json
bun scripts/agent-benchmark/run.ts --from-result scratch/agent-benchmarks/bug-repro/20261016T010203Z-1a2b3c4d
```

| Option                             | Meaning                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `--suite <name\|path.yml>`         | Run a committed suite by name or any suite file by path (repeatable).                  |
| `--all`                            | Run every suite in `benchmark/agent/suites/`.                                          |
| `--device <serial>`                | Target device. Without it, exactly one online device is required.                      |
| `--model <model>`                  | Override the suite's `claude.model` for a controlled comparison.                       |
| `--json`                           | Print the full result JSON instead of the text report.                                 |
| `--dry-run`                        | Validate suites and print the Claude command and MCP config; touches no device or API. |
| `--from-result <dir\|result.json>` | Re-render an earlier run without re-running Claude.                                    |
| `--claude <command>`               | Claude Code executable (default `claude`).                                             |
| `--output <dir>`                   | Artifact root (default `scratch/agent-benchmarks`).                                    |

The exit code is `0` when every run passed, `1` when any run failed or was incomplete, and `2`
for a usage error.

## What a run does

1. **Preflight (not measured).** Resolves the device, optionally installs the APK, force-stops
   the app, clears its data, seeds SharedPreferences, deep-links to the suite's start screen, and
   waits `settleSeconds`.
2. **Claude run (measured).** Spawns `claude -p --output-format stream-json` from an empty temp
   directory, with the prompt on stdin. `wallClockSeconds` covers only this step.
3. **Post-run (not measured).** Dumps the device screen with `uiautomator` when the suite has
   screen checks, then stops the run's private daemon.
4. **Audit.** Parses the transcript, scores the checks, compares against the baseline, and writes
   `result.json`.

### Isolation

Each run is isolated so earlier runs and your own setup cannot change the result:

- `--strict-mcp-config` with a generated config: only the auto-mobile server is available.
- Claude runs from an empty temp directory outside the repository. Claude Code loads `CLAUDE.md`
  from its working directory and every parent, so running from anywhere inside the checkout
  (including `scratch/`) would still pull in this repository's `CLAUDE.md` and skills.
- The server uses a **private daemon** (`AUTOMOBILE_AUX_SOCKET_DIR`), a **fresh database**
  (`AUTOMOBILE_DB_DIR`, so no learned navigation graph carries over), and its own log directory
  (`<run>/logs`). AutoMobile state overrides inherited from your shell, such as
  `AUTOMOBILE_DB_PATH`, `AUTOMOBILE_DAEMON_SOCKET_PATH`, and the legacy `AUTO_MOBILE_*` names, are
  removed first, because an explicit override would otherwise win over the run's values. The ADB
  coordination directory is shared on purpose, so a resident daemon's device claims are still
  respected. Stop other sessions on the target device before a run.
- `Bash` is disallowed by default, so the agent cannot fall back to raw `adb`.

## Verdicts

A run's verdict comes only from hard signals; baselines never change it.

| Verdict      | Meaning                                                                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `passed`     | Claude exited 0, the MCP server connected, the stream ended in a successful `result`, the transcript parsed cleanly, and every `verify` check passed.                                              |
| `failed`     | The run completed, but a `verify` check failed: the final answer or the device screen did not show the expected text.                                                                              |
| `incomplete` | The process timed out or exited non-zero, the MCP server did not connect, the `result` event is missing or an error (for example `error_max_budget_usd`), or the transcript has unparseable lines. |

`verify.answerIncludes` checks Claude's final reply, case-insensitively. Each expected string
must stand alone: it can't run on into a letter or digit, so `EXPECTED_COUNT: 3` doesn't match
`EXPECTED_COUNT: 30`. Suite prompts ask for a fixed final-line format so this is deterministic. `verify.screenIncludes` checks an independent
`uiautomator` dump taken after Claude exits. This is the oracle that catches an agent that
_reports_ success without achieving it.

**Stumbles** are tool results with `is_error`, failure-pattern matches in tool results, and
permission denials. They are reported, not scored.

## Suite format

Suites live in `benchmark/agent/suites/*.yml`, and prompts in `benchmark/agent/prompts/*.md`.
Unknown keys fail validation, so a typo cannot silently change what a run measures.

```yaml
name: bug-repro # must match the file name
platform: android
prompt: ../prompts/bug-repro.md # relative to this file
app:
  packageName: dev.jasonpearson.automobile.playground
  # apkPath: path/to/app.apk        # optional, relative to the repo root
preflight:
  clearAppData: true # default true
  sharedPreferences: # optional; written via run-as (debuggable builds)
    onboarding_prefs:
      onboarding_completed: true
  launchUri: automobile:playground/demos/bugs/repro
  settleSeconds: 2 # default 2
claude:
  model: claude-sonnet-5-5 # optional; --model overrides it
  appendSystemPrompt: "" # optional; {deviceSerial} {packageName} {runDirectory}
  allowedTools: [mcp__auto-mobile] # default
  disallowedTools: [Bash] # default
  maxBudgetUsd: 2 # optional hard spend cap per run
  timeoutSeconds: 600 # default 900
  extraArgs: [] # extra claude flags (not --model)
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

Playground suites seed `onboarding_prefs` and `auth_prefs` after clearing data, because the app
redirects every Demos deep link to onboarding until onboarding is complete and the user is signed
in.

## Baselines

Baselines are comparison data, not pass/fail gates. Metric rows show the actual value, the
baseline, and the delta. The tool sequence is shown as a longest-common-subsequence diff (`−`
means a baseline call the agent skipped, `+` means an extra call). Real runs can take equally valid
paths, so sequence drift never fails a run.

When a run passes, the harness writes `<run>/baseline.yml`, which you can paste into the suite.
Record baselines only from clean, passing runs. When establishing one, allow up to three
attempts. If none passes, leave the suite without a `baseline` block rather than recording a
failed run.

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
| `logs/`, `db/`                   | The private daemon's logs and database.                                   |
| `result.json`                    | The full result: run metadata, audit, checks, metrics, and sequence diff. |
| `baseline.yml`                   | A baseline snippet (passing runs only).                                   |

## Adding a suite

Pick a Playground screen with stable text and a deep link (see
`android/docs/playground-deep-links.md`), and design a task with an end state you can read
back from the screen. Write the prompt so the final reply ends in fixed `KEY: value` lines, and
add both `answerIncludes` and `screenIncludes`. Run it with `--dry-run` first, then for real. The
unit test `config.test.ts` loads every committed suite, so an invalid suite fails fast locally.
