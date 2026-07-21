---
name: auto-mobile-code-review
description: "Review and follow through an AutoMobile PR or branch diff: collect all GitHub feedback and exact-head CI evidence, apply two stable baseline review lenses plus one diff-specific lens, verify findings in code, address authorized in-scope issues, and resolve only truly addressed threads without posting review comments. Use for PR review, feedback cleanup, CI triage, or pre-merge regression review."
---

# AutoMobile Code Review

Review a change — a PR (its number passed as the argument) or, with no argument,
the current branch's diff vs `origin/main` — for correctness, regressions, and
fit with AutoMobile's architecture and conventions. For an eligible PR, one
invocation performs the full review-follow-through loop; the deliverable is a
**verified, actionable** review or a clean, evidence-backed PR state.

## Authority and modes

- A bare invocation for an active PR authored by the authenticated GitHub user
  uses **follow-through mode**: collect feedback and CI, review, fix only
  verified in-scope issues, validate, push, and resolve threads safely.
- A PR authored by someone else is **read/triage-only**. Do not resolve its
  threads through this skill. A user can also request review-only mode for their
  own PR.
- A merged or closed PR is **historical read-only** even when owned by the
  caller. Compare its merge commit and current `origin/main`, report whether a
  finding was remediated later, and require explicit authorization for any new
  follow-up branch or GitHub mutation.
- Never resolve a thread, rerun a job, push code, or declare CI green without
  the evidence and conditions in `github-pr-feedback` and `check-ci`.
- Never post a review, inline comment, conversation comment, or reply as part
  of this skill's review or follow-through process. Report findings to the user
  instead. Post only when the user separately and explicitly requests it.

## PR intake comes before review

For a PR, first invoke `github-pr-feedback` and `check-ci`. Capture one action
ledger covering the PR body/linked issue, all conversation and inline comments,
review submissions, every GraphQL review thread (including unresolved and
outdated state), current-head check runs, workflow runs/jobs, live/completed
logs, and relevant artifacts. Do this before assessing the diff; do not let a
flat comment list or aggregate green status hide feedback or duplicate/cancelled
checks.

After every push, discard the old ledger and repeat intake for the new head SHA.

## What a review is for

The verification discipline below is the floor, not the point. Automation and planning should be catching defects; spend the review on what they can't — understanding the change and helping the author. Approach it with curiosity, not correction:

- **Read for the author's intent first.** Work out what they were solving and how they weighed the alternatives before you judge the code — the comment should show you got it. Tie the change back to the issue/story it serves and review against *that*, not the diff in isolation.
- **A question often beats an assertion.** "What ruled out reusing `X` here?" surfaces more than "use `X`" — and sometimes the answer is that you missed something. Lead with the question when you're genuinely unsure.
- **Name what's genuinely good, briefly.** A real simplification, the correct hard call, clear product value — say so in a sentence. Recognition is signal; skip it when it isn't earned, and never manufacture it.
- **The findings still have to be verified.** None of this softens the bar below: ground every finding, reproduce before asserting, and deliver a few checked findings over many plausible ones.

## Scope the diff

- `git fetch origin main` first — always review against **latest main**, not a stale base.
- For a PR number: `gh pr view <n> --json title,body,headRefOid,files,closingIssuesReferences`, `gh pr diff <n>`, then read the changed files on disk and the **issue it claims to close**. A PR's reviewed head can differ from what squash-**merged**, and a "fix" PR can merge **test-only** — check `git log origin/main` for what actually landed.
- No argument: `git diff origin/main...HEAD`, then read the changed files in full (the hunk lies by omission).
- Use `github-cli`, `github-pr-feedback`, `check-ci`, and `pr-analysis` for
  GitHub mechanics and state. The review owns the final technical disposition.

## Review lenses

Use two stable baseline lenses on a substantive PR:

1. **Correctness and cross-layer contract** — verify the issue criteria, public
   API/schema, callers, platform boundaries, and release/deliverability where
   relevant.
2. **Regression and test adequacy** — probe negative paths, compatibility,
   lifecycle/concurrency/cleanup, test oracles, generated artifacts, and the
   regression or false-negative a change can introduce.

Generate one **diff-specific lens** after reading the issue criteria, changed
paths, action ledger, and CI evidence. Give it a concrete title and charter that
covers a risk the baseline lenses are less likely to focus on. Select it from
the actual change, for example: wire payload/default semantics; runner release
delivery; state-machine disposal; static-boundary bypasses; workflow and runner
environment semantics; security/data boundaries; or CI causality and
reproducibility. Do not use a generic third reviewer.

Measure the change with `git diff --numstat origin/main...HEAD` (or the PR
equivalent). For a PR of **100 changed lines or fewer**, use only the first
baseline lens by default; add the diff-specific lens only when the change or
feedback exposes a nontrivial risk. For larger or riskier PRs, run both baseline
lenses plus the generated lens.

When delegation is available, assign one lens per agent. Give each the issue
criteria, current head SHA, changed files, action ledger, and a precise
exclusion list naming the other lenses. Agents return evidence only and never
edit. Report the selected diff-specific lens and its rationale in the review
summary. An optional caller-supplied concern is input to its selection, not a
substitute for it.

## Review principles (verify, don't speculate)

1. **Ground every finding in code.** Cite `file:line` and read the surrounding context — never assert from the diff text or memory alone.
2. **Reproduce before asserting a bug.** Run it: `sqlite3` the TCC db, query `~/.auto-mobile/auto-mobile.db`, run the `cmd locale` subcommand, drive the tool on a device. If you can't run it, label the finding **unverified** and give the exact repro. (Reproduce locally — e.g. `sqlite3 .mode json` "extra argument", invalid `cmd locale set-locales` — before filing.)
3. **Separate real bugs from environment/session artifacts.** A tool failing with `Session not found` is almost always the daemon-restart **session wedge**, not a bug in that tool — confirm with a second, unrelated tool. A slow tool call may be the ctrlproxy slow-network runner download. Disambiguate before filing.
4. **Check provenance + current state.** `git blame` the lines: don't blame the PR for pre-existing code. `git log origin/main -- <file>` to see if it's already fixed or superseded — inspect **latest main**, not just the diff.
5. **For a fix PR, verify it closes the ISSUE, not just the symptom — and name the false-negative it introduces.** Ask "what does this change stop catching?" e.g. narrowing daemon detection to the pid-file PID kills a false positive but stops detecting a live cross-worktree rogue daemon; a `success ?? true` default reports a non-render as a successful highlight.
6. **Prefer reuse + existing conventions over new code.** Find the existing helper first and recommend *that* (see gotchas below).
7. **Know which layer owns a field.** The CtrlProxy runner emits the **raw** hierarchy; the TS layer **adds** fields (the `view-id` content-hash, the duplicated `elements` arrays). For a claim about the runner, verify against the runner's `connected` handshake `supportedCommands` / raw hierarchy, not the post-processed TS output.
8. **Tests must follow repo conventions and prove the behavior.** Interface + Fake + FakeTimer, no real device/network, <100ms per unit test. Flag a fix lacking the test the issue asked for, and flag tests **narrowed to a new contract to pass** rather than proving the original behavior holds.

## Architecture (for grounding)

- **MCP server (`src/`, TS/Bun)** forwards tool calls to a **daemon** (`src/daemon/`) that owns a **DevicePool** and per-platform **CtrlProxy runners**: the Android accessibility-service APK (`android/control-proxy`) and the iOS XCUITest runner (`ios/control-proxy`), each speaking a WebSocket protocol (iOS on `:8765`). Apps under test may embed the **AutoMobile SDK** (`android/auto-mobile-sdk`, `ios/auto-mobile-sdk`) for in-app capabilities (DB inspection, network mock, highlight overlay) relayed through the runner.
- Tools are registered in `src/server/index.ts`. The IDE/test-plan artifact `schemas/tool-definitions.json` is **generated** by `scripts/generate-tool-definitions.ts`.

## Repo-specific gotchas to weigh (hard-won)

- **Daemon lifecycle:** one per-UID socket + pidfile shared across worktrees, **per-connection** session — restarting the daemon **wedges** connected MCP clients (`Session not found`, no auto-recovery). Live-daemon detection should scan the full `ps` table for `--daemon-mode` and filter by **liveness** (catches cross-worktree rogues, drops dead probes), **not** narrow to the pid-file PID. Takeover must escalate SIGTERM→SIGKILL (daemons ignore SIGTERM). `findAllDaemonProcesses` should **fail closed** (throw), not return `[]`, on a `ps` error.
- **CtrlProxy capability gate:** every tool is gated by the runner's `connected` handshake `supportedCommands`. The daemon **downloads a pinned release runner** (version-agnostic cache), so local runner changes need overrides — Android: `AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED` / `AUTOMOBILE_CTRL_PROXY_APK_PATH`; iOS: `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH`. When iOS runner source changes, the release + checksum registry (`src/constants/release.ts`) must be re-cut or the feature is undeliverable. A mismatch between advertised `supportedCommands` and what TS routes is a real bug (e.g. `pinchOn` refuses iOS while the runner advertises `request_pinch`).
- **Release-build SDK gating:** debug-only SDK behavior (network-mock enforcement, DB inspector, highlight overlay) MUST be `#if DEBUG`-gated. Verify a **release** build can't ship it — check the enforcement path, not just the rule-setting route.
- **Schema drift:** `schemas/tool-definitions.json` is generated and silently drifts. The generator must register the **same** `register*Tools` categories as `src/server/index.ts`; flag any production tool missing from the artifact (and any gated/daemon-only tool falsely advertised). No CI drift guard exists.
- **Deliverability:** a source change under `ios/control-proxy` or another
  downloaded runner is not shipped until its signed release/version/checksum
  path is updated. Source tests alone do not prove ordinary users receive it.
- **Wire contracts:** for shared codecs, DTOs, defaults, aliases, or
  serialization configuration, inspect every transport boundary and assert raw
  payloads, including omitted defaults and explicit `null`; decoder-only tests
  can hide a breaking encoder change.
- **Negotiation and partial creation:** offer/answer or capability work must
  exercise a remote rejection, fail the public operation early, and clean up any
  resource created before the rejection.
- **State machines and artifacts:** streaming/UI work must cover clean terminal
  EOF, error/unavailable, queued asynchronous work completing after terminal
  state, and disposal while work is pending. For generated recordings/downloads,
  verify the real artifact invariant (for example non-empty and decodable), not
  a proxy log line.
- **Boundary ratchets:** a process/API boundary check must inventory sync and
  async forms, named and namespace imports, and literal and variable arguments.
  Prefer an existing structured parser over a line regexp; add a bypass matrix
  so moving one call form behind a helper does not leave an equivalent escape.
- **Workflow controls:** test CI gates against both failing and healthy runner
  evidence, including the GitHub Actions environment. Assert the intended
  post-condition or per-step semantic property, not an incidental status/log
  sentinel, exact expression string, or global count that can be compensated
  elsewhere.
- **Relative paths under a detached daemon:** after the daemon `chdir`s to a stable cwd, a relative path arg MUST go through `resolvePathFromDaemonLaunchWorkingDirectory`. Grep for raw `fs.stat`/`copyFile`/`readFile` on a user-supplied relative path.
- **Per-device singletons:** managers use `getInstance(device)` keyed by deviceId; an instance-level cache persists across calls — verify a cache fix persists where it's read.
- **Plan vs MCP tool lookup:** plan/criticalSection execution must resolve via `getToolForPlan()`, not `getTool()` (the MCP-visibility gate) — otherwise `planExecutable`-but-hidden tools won't resolve inside a plan.
- **Conditional schemas:** the flattener emits JSON-Schema `if/then` (e.g. `postNotification` requires `appId` iff iOS). Verify the host accepts it and that `appId` aliases (`bundleId`/`packageName`) are coerced, including nested (`systemTray.notification.appId`).
- **Huge outputs:** `observe`/action results carry the full hierarchy (~25k tokens); `elements` duplicates the tree. Summarize — never paste raw hierarchies. Save long output under `scratch/`.
- **Use the right tool form:** `sqlite3 -json <db> "<one statement>"`, NOT `.mode json` + SQL combined in one positional arg (errors "extra argument").

## Output

For **each** finding, cover three things in plain prose: your read on the change (is it a real bug, does the fix hold, are you confident or only suspicious), where it is (`file:line`, and how you checked — reproduced, read the code, checked main, `git blame`), and how to fix it (a named existing helper/convention where one fits, the manual device check that would confirm it, and any regression or false-negative the change risks).

In follow-through mode, triage the ledger, make only verified in-scope fixes,
run the targeted validation, commit and push, then resolve through
`github-pr-feedback` when the resolution conditions hold. In review-only mode,
present findings to the user. In both modes, do not post review comments.

Close with a one-paragraph **summary verdict**, the single most important thing
to verify first, and the action ledger's remaining blocker (feedback, CI,
authorization, or pending job). Stay skeptical: a verified "couldn't reproduce"
beats an unverified bug report.
