---
description: AutoMobile-specific code review — ground every finding in file:line, reproduce before asserting, separate real bugs from session/env artifacts, prefer reusing repo helpers/conventions, and catch the regression or false-negative a fix can introduce. Reviews a PR number or the current branch diff.
allowed-tools: Bash, Read, Grep, Glob, WebFetch
argument-hint: [PR number (optional; default = current branch diff vs origin/main)]
---

# AutoMobile Code Review

Review a change — a PR (`$ARGUMENTS` = its number) or, with no argument, the current branch's diff vs `origin/main` — for correctness, regressions, and fit with AutoMobile's architecture and conventions. The deliverable is a **verified, actionable** review: fewer findings, each grounded and checked, beats a long list of plausible-but-unverified concerns.

## Scope the diff

- `git fetch origin main` first — always review against **latest main**, not a stale base.
- With `$ARGUMENTS` (a PR number): `gh pr view $ARGUMENTS --json title,body,headRefOid,files,closingIssuesReferences`, `gh pr diff $ARGUMENTS`, then read the changed files on disk and the **issue it claims to close**. A PR's reviewed head can differ from what squash-**merged**, and a "fix" PR can merge **test-only** — check `git log origin/main` for what actually landed.
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

For **each** finding, cover three things in plain prose:
- your read on the change — is it a real bug, does the fix hold, are you confident or only suspicious;
- where it is — `file:line`, and how you checked (reproduced, read the code, checked main, `git blame`);
- how to fix it — a named existing helper/convention where one fits, the manual device check that would confirm it, and any regression or false-negative the change risks.

When reviewing a PR, post findings as **inline review comments** anchored to the changed line (`gh api repos/<owner>/<repo>/pulls/<n>/reviews` with a `comments[]` array, `event: COMMENT`), with a short summary body — not one monolithic comment.

### Write the comment so a busy author acts on it

The finding can be correct and still land badly if it's a wall of text. Word each inline comment so the author sees the finding, the ask, and the repro without decoding a paragraph:

- **Open with a question when it earns its place — otherwise state the finding flat.** A question is right when you genuinely don't understand the code, or when walking the author down your reasoning before you answer it reads better than asserting. When the finding is clear, just say what the bug is in one plain sentence — no `Found a bug`, no severity label. `Nit:` is the only label; reserve it for the genuinely minor.
- **State the mechanism as the finding, not under it.** One plain sentence — `X does A, so B never happens` — every symbol, file, and flag in backticks, an em-dash for the consequence. Don't bury the finding beneath a paragraph of trace; the mechanism *is* the lede.
- **Offer a `Suggested change for <reason>` with a ```suggestion block when the fix is a concrete line edit.** Let the author accept or reject it inline instead of re-typing your prose into code.
- **Skip the `Verdict:`/`Evidence:`/`Fix:` labels and the enum verbatim in the posted comment.** That structure is a checklist of what to cover — your read on the change, where it is, how to fix it — not a template to stamp into GitHub. Write it as ordinary prose, loose with wording and capitalization; `this basically double-frees the handle` beats `**Verdict:** Confirmed bug`. Drop how-you-verified parentheticals (`(verified by reading code)`, "a concern I checked and dropped") — the `file:line` citation carries that, and they read as defensive.
- **Put the reproduction on its own line.** A concrete repro is the most valuable thing in a bug comment — make it separable so the author can run it without re-deriving your claim.
- **Keep every comment tight.** Say the thing in as few words as it takes; don't re-enumerate findings or restate the diff — the reader can find and read them.
- **Say whether it blocks in plain words.** `this should block` or `not a blocker`, as a normal clause in the finding — don't spin up a label or severity track for it.
- **If a thread's already been addressed, resolve it — don't write a comment.** A resolved thread already says "done"; a new comment saying so is noise.

A worked rewrite — the wall first, the same finding second:

> ❌ I looked into this and I believe there may be an issue where the timer scheduled by `scheduleAutoStop` ends up calling `this.stop()` (verified by reading the code), which as far as I can tell finalizes the session but does not appear to remove it from `byHandle`, so this could potentially be a concern.
>
> ✅ The auto-stop timer calls `this.stop()`, which finalizes the session but never removes it from `byHandle` — that delete lives only in `stopAndRemove`, which auto-stop doesn't go through, so an auto-stopped session stays registered forever.
> Set `maxDuration`, never call stop — after the timer fires, `byHandle` still holds the entry.

Close with a one-paragraph **summary verdict** and the single most important thing to verify first. Stay skeptical: a verified "couldn't reproduce" is a more useful result than an unverified bug report.
