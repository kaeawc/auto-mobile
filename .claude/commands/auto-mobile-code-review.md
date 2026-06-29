---
description: AutoMobile-specific code review — ground every finding in file:line, reproduce before asserting, separate real bugs from session/env artifacts, prefer reusing repo helpers/conventions, and catch the regression or false-negative a fix can introduce. Reviews a PR number or the current branch diff.
allowed-tools: Bash, Read, Grep, Glob, WebFetch
argument-hint: [PR number (optional; default = current branch diff vs origin/main)]
---

# AutoMobile Code Review

Review a change — a PR (`$1` = its number) or, with no argument, the current branch's diff vs `origin/main` — for correctness, regressions, and fit with AutoMobile's architecture and conventions. The deliverable is a **verified, actionable** review: fewer findings, each grounded and checked, beats a long list of plausible-but-unverified concerns.

## Scope the diff

- `git fetch origin main` first — always review against **latest main**, not a stale base.
- With `$1` (a PR number): `gh pr view $1 --json title,body,headRefOid,files,closingIssuesReferences`, `gh pr diff $1`, then read the changed files on disk and the **issue it claims to close**. A PR's reviewed head can differ from what squash-**merged**, and a "fix" PR can merge **test-only** — check `git log origin/main` for what actually landed.
- No argument: `git diff origin/main...HEAD` and read the changed files in full (the hunk lies by omission).

## Review principles (verify, don't speculate)

1. **Ground every finding in code.** Cite `file:line`. Open the actual file and read the surrounding context — never assert from the diff text or memory alone.
2. **Reproduce before asserting a bug.** Run it: `sqlite3` the TCC db, query `~/.auto-mobile/auto-mobile.db`, run the `cmd locale` subcommand, drive the tool on a device. If you can't run it, label the finding **unverified** and state exactly how to verify it. (This session reproduced the `sqlite3 .mode json` "extra argument" failure and the invalid `cmd locale set-locales` locally before filing — do that.)
3. **Separate real bugs from environment/session artifacts.** A tool failing with `Session not found` is almost always the daemon-restart **session wedge** (#2599), not a bug in that tool — confirm by trying a second, unrelated tool. A slow `sqlQuery` may be the ctrlproxy slow-network runner download, not the query. Disambiguate before filing.
4. **Check provenance + current state.** `git blame` the lines: don't blame the PR for pre-existing code. `git log origin/main -- <file>` to see if it's already fixed or superseded — inspect **latest main**, not just the diff (this session found #2615 had merged **test-only**, mooting a false-negative concern).
5. **For a fix PR, verify it closes the ISSUE, not just the symptom — and name the false-negative it introduces.** Ask "what does this change stop catching?" Examples seen here: a daemon-dedup fix that narrowed detection to the pid-file PID would have killed the false positive but stopped detecting a **live cross-worktree rogue daemon**; a `success ?? true` default reports a non-render as a successful highlight.
6. **Prefer reuse + existing conventions over new code.** Find the existing helper first and recommend *that*, not a new mechanism (see gotchas below).
7. **Know which layer owns a field.** The CtrlProxy runner emits the **raw** hierarchy; the TS layer **adds** fields (the `view-id` content-hash, the duplicated `elements` arrays). When a claim is about the runner, verify against the runner's `connected` handshake `supportedCommands` / raw hierarchy — not the post-processed TS output.
8. **Tests must follow repo conventions and actually prove the behavior.** Interface + Fake + FakeTimer, no real device/network, <100ms per unit test (`CLAUDE.md`/`AGENTS.md`). Flag a fix lacking the test the issue asked for (e.g. an end-to-end `start`→`stop` non-empty-`.mp4` assertion), and flag tests **narrowed to a new contract to pass** rather than proving the original behavior still holds.

## Architecture (for grounding)

- **MCP server (`src/`, TS/Bun)** forwards tool calls to a **daemon** (`src/daemon/`) that owns a **DevicePool** and per-platform **CtrlProxy runners**: the Android accessibility-service APK (`android/control-proxy`) and the iOS XCUITest runner (`ios/control-proxy`), each speaking a WebSocket protocol (iOS on `:8765`). Apps under test may embed the **AutoMobile SDK** (`android/auto-mobile-sdk`, `ios/auto-mobile-sdk`) for in-app capabilities (DB inspection, network mock, highlight overlay) relayed through the runner.
- Tools are registered in `src/server/index.ts`. The IDE/test-plan artifact `schemas/tool-definitions.json` is **generated** by `scripts/generate-tool-definitions.ts`.

## Repo-specific gotchas to weigh (hard-won this session)

- **Daemon lifecycle:** one per-UID socket + pidfile shared across worktrees, **per-connection** session — restarting the daemon **wedges** connected MCP clients (`Session not found`, no auto-recovery; #2599). Live-daemon detection should scan the full `ps` table for `--daemon-mode` and filter by **liveness** (catches cross-worktree rogues, drops dead probes), **not** narrow to the pid-file PID (false-negative). Takeover must escalate SIGTERM→SIGKILL (daemons ignore SIGTERM). `findAllDaemonProcesses` should **fail closed** (throw), not return `[]`, on a `ps` error.
- **CtrlProxy capability gate:** every tool is gated by the runner's `connected` handshake `supportedCommands`. The daemon **downloads a pinned release runner** (version-agnostic cache), so local runner changes need overrides — Android: `AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED` / `AUTOMOBILE_CTRL_PROXY_APK_PATH`; iOS: `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH`. When iOS runner source changes, the release + checksum registry (`src/constants/release.ts`) must be re-cut or the feature is undeliverable. A mismatch between advertised `supportedCommands` and what the TS layer routes is a real bug (e.g. `pinchOn` refuses iOS while the runner advertises `request_pinch`).
- **Release-build SDK gating:** debug-only SDK behavior (network-mock enforcement, DB inspector, highlight overlay) MUST be `#if DEBUG`-gated. Verify a **release** build can't ship it — check the enforcement path, not just the rule-setting route (the iOS network mock had the *setter* gated but the *enforcement* short-circuit outside `#if DEBUG`).
- **Schema drift:** `schemas/tool-definitions.json` is generated and silently drifts. The generator must register the **same** `register*Tools` categories as `src/server/index.ts`; flag any production tool missing from the artifact (and any gated/daemon-only tool falsely advertised). No CI drift guard exists.
- **Relative paths under a detached daemon:** after the daemon `chdir`s to a stable cwd (#2564), a relative path arg MUST go through `resolvePathFromDaemonLaunchWorkingDirectory`. Grep for raw `fs.stat`/`copyFile`/`readFile` on a user-supplied relative path (this is how `putAppFile`'s `sourcePath` was caught).
- **Per-device singletons:** managers use `getInstance(device)` keyed by deviceId; an instance-level cache persists across calls — verify a cache fix actually persists where it's read.
- **Plan vs MCP tool lookup:** plan/criticalSection execution must resolve via `getToolForPlan()` (what `PlanExecutor` uses), not `getTool()` (the MCP-visibility gate) — otherwise `planExecutable`-but-hidden tools won't resolve inside a plan.
- **Conditional schemas:** the flattener emits JSON-Schema `if/then` (e.g. `postNotification` requires `appId` iff iOS). Verify the host accepts it (not just that it's generated) and that `appId` aliases (`bundleId`/`packageName`) are coerced, including nested (`systemTray.notification.appId`).
- **Huge outputs:** `observe`/action results carry the full hierarchy (~25k tokens); `elements` duplicates the tree; `bounds` is a 4-key object. Summarize — never paste raw hierarchies into the review.
- **Use the right tool form:** `sqlite3 -json <db> "<one statement>"`, NOT `.mode json` + SQL combined in one positional arg (errors "extra argument").

## Output

For **each** finding:
- **Verdict** — one of: `Confirmed bug` · `Correctly fixes` · `Partial` · `Risky (regression / false-negative)` · `Already fixed on main` · `False positive (couldn't reproduce)`.
- **Evidence** — `file:line` + how you verified (reproduced / read code / checked main / `git blame`).
- **Fix** — prefer a named existing helper/convention; the manual device check to confirm it; and any regression or false-negative the change risks.

When reviewing a PR, post findings as **inline review comments** anchored to the changed line (`gh api repos/<owner>/<repo>/pulls/<n>/reviews` with a `comments[]` array, `event: COMMENT`), with a short summary body — not one monolithic comment.

Close with a one-paragraph **summary verdict** and the single most important thing to verify first. Stay skeptical: a verified "couldn't reproduce" is a more useful result than an unverified bug report.
