---
name: auto-mobile-code-review
description: Use this workflow skill to review an AutoMobile change (a PR number or the current branch diff) the way this repo demands — check the PR's real CI, merge and base state first, then run diff-sized review lenses (two fixed, one generated) covering runtime behavior and delivery/enforcement, grounding every finding in file:line and reproducing before asserting. Never posts to GitHub; resolves review threads only on a PR we authored and are actively working.
---

# AutoMobile Code Review

Review a change — a PR (its number passed as the argument) or, with no argument, the current
branch's diff vs `origin/main` — for correctness, regressions, and fit with AutoMobile's
architecture. The deliverable is a **verified, actionable** review: fewer findings, each
grounded and checked, beats a long list of plausible-but-unverified concerns.

## Never post to GitHub

This skill does not write review comments, reviews, or summaries to GitHub. Report findings
in the session and let the author decide what lands. The **only** GitHub write it may make
is resolving a review thread, and only under the conditions in *Working our own PR* below.

## What a review is for

The verification discipline is the floor, not the point. Automation and planning should be
catching defects; spend the review on what they can't. Approach it with curiosity, not
correction:

- **Read for the author's intent first.** Work out what they were solving and how they
  weighed the alternatives before judging. Tie the change back to the issue it serves and
  review against *that*, not the diff in isolation.
- **A question often beats an assertion.** "What ruled out reusing `X`?" surfaces more than
  "use `X`" — and sometimes the answer is that you missed something.
- **Name what's genuinely good, briefly.** A real simplification or the correct hard call —
  say so in a sentence. Skip it when it isn't earned; never manufacture it.

## Step 1 — Establish the change's real state, before reading any code

A large share of this repo's escaped defects were already demonstrated red on the PR itself.
Reading the diff first and the CI last inverts the cost: these checks are seconds long and
frequently end the review.

For a PR, run all four:

```bash
gh pr checks <N> --json name,state,bucket,link
gh pr view <N> --json mergedAt,mergeable,mergeStateStatus,baseRefOid,headRefOid,autoMergeRequest,statusCheckRollup
```

- **Any check with conclusion `failure` is a blocking finding — required or not.** Automerge
  lands PRs over non-required failures. #3969 auto-merged with `Build Xcode Projects`,
  `XCTestRunner Simulator Tests`, and `iOS Build` all red; the drift check had caught the
  pbxproj defect exactly as designed and the merge gate simply never consulted it.
- **Unfinished checks with automerge armed are equally blocking.** #4088 merged five seconds
  before `Swift Packages (Xcode 26.5)` concluded failure, and two seconds before its
  aggregate gate did. For an already-merged PR, verify the gates concluded *before* the
  merge, not merely that they exist:
  ```bash
  gh api repos/kaeawc/auto-mobile/commits/<headRefOid>/check-runs?per_page=100 \
    --jq '.check_runs[] | "\(.name)\t\(.conclusion)\t\(.completed_at)"'
  ```
  Any `completed_at` at or after `mergedAt` means the gate did not gate.
- **Green checks are only as current as the base they ran on.** If `baseRefOid` differs from
  `origin/main`, the PR may never have run against a gate that has since landed:
  ```bash
  git log <baseRefOid>..origin/main --name-only -- \
    .github/workflows scripts/all_fast_validate_checks.sh \
    android/build.gradle.kts android/gradle/libs.versions.toml \
    eslint.config.* scripts/typecheck-baseline.txt eslint-suppressions.json
  ```
  Any hit means "rebase and re-run" rather than approval. #4016 went green at 05:44, #4005
  turned on the detekt gate at 05:48, and #4016 auto-merged at 05:49 — reddening main and
  blocking unrelated PRs. Its `Fast Validation` job simply had no `Run detekt` step.
- **Run the tests the diff changed.** #4070 carried a deterministically-red assertion into
  main because a refactor moved argv construction but updated only one of two sibling tests.
  ```bash
  git diff --name-only origin/main...HEAD -- 'test/**/*.test.ts' | xargs -r bun test
  ```

When a check is red, pull that job's log rather than the whole run — a finished job's log is
readable while the rest of the run is still going. See the `github-cli` skill.

## Step 2 — Scope and size the diff

- `git fetch origin main` first — always review against **latest main**, not a stale base.
- With a PR number: `gh pr view <N> --json title,body,headRefOid,files,closingIssuesReferences`,
  `gh pr diff <N>`, then read the changed files on disk and the **issue it claims to close**.
  A PR's reviewed head can differ from what squash-**merged**, and a "fix" PR can merge
  **test-only** — check `git log origin/main` for what actually landed.
- No argument: review the branch **and** any uncommitted work. Read the changed files in
  full — the hunk lies by omission.

Pick the diff base deliberately — both obvious choices are wrong in a common case:

- `origin/main...HEAD` (three dots) is **committed work only**. Against a dirty working tree
  it reports zero changed files and the review silently scopes itself to nothing.
- `git diff origin/main` (no dots) picks up uncommitted work, but when the branch is *behind*
  main it also folds main's newer commits in as reverse-diffs, attributing other people's
  changes to this review.

Use the merge-base, which is correct in every case — committed and uncommitted work on this
branch, and nothing from main:

```bash
BASE=$(git merge-base HEAD origin/main)
git diff --numstat "$BASE" -- . \
  ':(exclude)**/*.lock' ':(exclude)bun.lockb' ':(exclude)schemas/**' \
  ':(exclude)**/project.pbxproj' ':(exclude)eslint-suppressions.json' \
  | awk '{a+=$1; d+=$2} END {print a+d" changed lines across "NR" files"}'
```

Use that same `$BASE` for every later `git diff` in the review, and sanity-check the file
count against what you expect before going further. Also report how far behind main the
branch is (`git rev-list --count HEAD..origin/main`) — the Step 1 stale-base check applies to
branch reviews too, not just PRs.

## Step 3 — Pick lenses by size

A lens is a review pass with a fixed field of view. Run each as a **separate subagent** so
one lens cannot dilute another, then merge and dedupe the findings yourself.

- **Over 100 changed lines** → run all three: **Runtime Behavior**, **Delivery &
  Enforcement**, and one **generated lens** (Step 6).
- **100 or fewer** → skip the generated lens. Run the one constant lens the diff plainly
  belongs to; run both when it straddles them (a `src/` change that also edits a workflow
  or a guard script always straddles).
- Trivial diffs — a version bump, a comment, a string change with no behavioral reach —
  get one lens and a short answer. Don't manufacture three passes for a one-line change.

Brief each lens subagent with: the diff, the issue it closes, this file's *Verification
discipline* section, that lens's checklist verbatim, and the isolation rule below.

### Lens subagents must not mutate the working tree

This is not advisory. A lens told to "review PR #N" will reach for `git checkout` and
silently destroy the invoking session's state — this repo has ~100 live worktrees sharing one
object store, so the blast radius is not limited to the reviewer. Put this in every brief:

> Do not run `git checkout`, `git switch`, `git stash`, `git reset`, `git restore`, or
> `git branch -f` in this worktree. It is not yours and other work depends on its state.

Read PR content without checking anything out:

```bash
gh pr diff <N>                                   # the diff
gh pr view <N> --json files,title,body           # metadata
git fetch origin pull/<N>/head:refs/remotes/pr/<N>   # remote-tracking ref, no checkout
git show refs/remotes/pr/<N>:<path>              # any file at the PR head
```

If a lens genuinely needs a populated tree — to run a guard script, a test, or a build — it
must make its own and clean it up:

```bash
git worktree add "$SCRATCH/lens-<N>" refs/remotes/pr/<N>
# ... work ...
git worktree remove --force "$SCRATCH/lens-<N>"
```

Be aware that a fresh worktree has **no `node_modules`**, so any check that resolves an npm
dependency (the TypeScript-AST guards under `scripts/`, `bun test`) will fail there for
environmental reasons that look exactly like real findings. Symlinking `node_modules` in is
not reliably enough either. When a check needs deps, prefer running it in the primary
worktree against a single file copied from the PR head, and restore that file immediately.

## Step 4 — Lens A: Runtime Behavior

*Does the changed code actually do the thing, on every path a user can reach?*

- **Reachability — is the new code on the real entry path?** The most common miss in this
  repo. New logic gets added to one converter/executor while the public tool call routes
  through a different one. For each new function or branch, trace *backwards* to the MCP
  tool entry point and prove a user request reaches it. Grep for the caller; don't assume.
  Seen as: heading promotion added to `CtrlProxyHierarchy.convertToViewHierarchyResult`
  while `observe` goes through `ViewHierarchy.getiOSViewHierarchy` → `convertXCTestHierarchy`;
  a VoiceOver-unsupported result unreachable because `lookFor` swipes divert to
  `ScrollUntilVisible`.
- **Ordering around `await`.** Was a listener, error handler, or failure callback registered
  *after* the first `await`, so early events are lost? Did an `await` get inserted between a
  check and the corresponding `set`, opening a TOCTOU window for concurrent callers? Read
  every `await` added in the diff and ask what can happen during it.
- **Error and degradation paths.** What happens on spawn failure, EOF, malformed cached
  metadata, a download failure, an abort mid-flight? A `catch` must follow one of the three
  strategies in `CLAUDE.md`/`AGENTS.md` — throw `ActionableError`, log-then-return-typed-failure,
  or log-at-debug-and-continue *with a comment saying why it's safe*. Flag silent swallows,
  and flag optimistic success (`success ?? true`) that reports a non-event as a win.
- **Cross-layer shape contracts.** The CtrlProxy runners emit the **raw** hierarchy; the TS
  layer *adds* fields. Android pushes `AccessibilityHierarchy` where `hierarchy` is already
  the root; the MCP wrapper shape is different. Code that walks one shape and receives the
  other fails silently — verify which shape the actual caller passes.
- **Overrides, injection, and persistence.** Does an injected data-dir/env override survive
  the path being changed, or does a default overwrite it? Per-device `getInstance(device)`
  singletons hold instance-level caches — verify a cache fix persists *where it is read*.
- **Concurrency and identity.** Two concurrent calls for the same device; a cleanup path
  that deletes a *replacement* resource; a callback that fires for a superseded encoder.
  Guard by identity, not by presence.
- **Process spawning and argument handling.** `spawn(..., { shell: true })` concatenates
  `args` for the shell instead of preserving argv boundaries, so any dynamic value — an AVD
  name, a path — can carry shell syntax. This recurred all week across Windows `.bat`/`cmd`
  paths. Prefer a non-shell executable path; where a shell is unavoidable, quote explicitly.
- **Relative paths under the detached daemon.** The daemon `chdir`s to a stable cwd (#2564),
  so a user-supplied relative path must go through
  `resolvePathFromDaemonLaunchWorkingDirectory`. Grep the diff for raw `fs.stat`/`readFile`/
  `copyFile` on an argument-derived path — this is how `putAppFile`'s `sourcePath` was caught.

## Step 5 — Lens B: Delivery & Enforcement

*Does the change actually ship, and does the thing that's supposed to enforce it work?*

This lens exists because a correct-looking diff in this repo routinely ships nothing.

- **Runner source changed ⇒ the release artifact must be re-cut.** If the diff touches
  `ios/control-proxy/Sources/**` or `android/control-proxy/**`, the daemon still downloads
  the pinned released runner. Unless `src/constants/release.ts` checksums are updated in the
  same PR (or a re-cut is explicitly sequenced), the feature is **undeliverable** and the
  issue is not closed. Check:
  `git diff origin/main...HEAD --name-only | grep -E '^(ios|android)/control-proxy/' `
  and then whether `src/constants/release.ts` is in the same diff. This is a blocking finding.
- **New Swift file ⇒ regenerate the Xcode project.** A new file under
  `ios/control-proxy/Sources/**` that is absent from the committed
  `ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj` is not compiled on a normal
  checkout. Verify:
  `grep -c '<NewSymbol>' ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj` — zero means
  `xcodegen generate` was not run and committed.
- **Generated artifacts drift silently.** `schemas/tool-definitions.json` is generated by
  `scripts/generate-tool-definitions.ts`; the generator must register the same `register*Tools`
  categories as `src/server/index.ts`. Flag any production tool missing from the artifact, and
  any daemon-only tool falsely advertised. The flattener also emits JSON-Schema `if/then` for
  conditional requirements (`postNotification` requires `appId` iff iOS) — verify the host
  *accepts* it, not merely that it's generated, and that `appId` aliases (`bundleId`,
  `packageName`) are coerced including nested ones like `systemTray.notification.appId`.
- **Debug-only SDK behavior must be `#if DEBUG`-gated, on the enforcement path.** Network-mock
  enforcement, the DB inspector, and the highlight overlay must be unable to ship in a release
  build. Check the *enforcement* short-circuit, not just the rule-setting route — the iOS
  network mock had its setter gated while the enforcement path sat outside `#if DEBUG`.
- **A new guard script must actually guard.** This repo's `scripts/check-*` boundary ratchets
  are the single largest source of accepted findings. For any changed or added guard:
  - Does its pattern match **every** form of the thing it bans? Template literals
    (`` `simctl ${x}` ``), array/argv form, multiline argv, `exec`/`execSync`,
    `spawnSync`, destructured `const {execFile} = require('child_process')`, and
    `/bin/sh -c` wrappers are the forms it has repeatedly missed. Write a hostile example
    of each and run the guard against it.
  - Does it **fail closed**? A guard that cannot compute its diff base must exit non-zero,
    not exit 0. `origin/main` is absent in a depth-1 `actions/checkout` — a guard that
    assumes it will silently pass on every PR.
  - Is it **registered** in `scripts/all_fast_validate_checks.sh` via `add_check`, with a
    **unique** name? Two checks sharing a name collide on `$run_dir/${name}.log` and one
    result overwrites the other.
- **CI job wiring.** If the diff touches `.github/workflows/**`:
  - A new job that isn't in the required roll-up gate removes a merge blocker rather than
    adding one. Trace the new job to the gate job's `needs:` list.
  - Does the job install what the changed script needs? A BATS test that shells into a Bun
    script fails on a `bats-tests` job that never sets up Bun.
  - Do `if:` conditions still carry their guard? `!cancelled()` without the build gate
    re-enables a leg that was meant to be gated.
  - Flags and matrix values must survive YAML → shell. A JSON-array input joined into a
    string, or gradle flags that lose their spaces, silently drop every flag. Hand-simulate
    the interpolation and quoting; a GitHub expression pasted into a quoted shell string is
    a distinct failure from one passed as an argument.
  - **A new `if:` path filter can silently un-gate a job.** When a job gains
    `if: needs.detect-changes.outputs.<x> == 'true'`, compare the `dorny/paths-filter` globs
    against the paths the script *it runs* treats as significant. #4026 gated detekt on a
    filter that omitted `android/gradle/wrapper/**`, which `scripts/android/detekt_scope.sh`
    itself treats as a full-scope trigger — so a wrapper bump skipped detekt entirely instead
    of failing open.
- **Post-merge-only workflows are invisible to PR CI.** These never run on `pull_request`:
  `merge.yml` (On Merge), `nightly.yml`, `dead-code-detection.yml`, `release.yml`,
  `prepare-release.yml`, `record-screenshot-baselines.yml`. The three reusable builders —
  `build-control-proxy-apk.yml`, `build-ctrl-proxy-ios-ipa.yml`, `build-video-server-jar.yml`
  — are `workflow_call` only and are referenced solely by nightly/prepare-release/release, so
  APK/IPA signing, jar reproducibility, and sha256 computation are **never** exercised
  pre-merge. Merge-only jobs with no PR counterpart include `publish-android-libraries-snapshot`,
  `deploy-docs`, the coverage jobs, `benchmark-context-thresholds`, and `update-readme-badges`;
  ktfmt and detekt run **full-tree** on merge but scoped or path-gated on PRs. When the diff
  touches `.github/**` or `scripts/(ci|android|ios)/**`, reason about these statically and
  confirm the destination leg is currently green (`gh run list --workflow=nightly.yml -L 5`) —
  a change landing on an already-red leg hides its own regression.
- **New exports need a consumer.** `dead-code-detection.yml` is weekly-only and has been red
  for months (271 findings against a threshold of 10, twelve duplicate issues filed and
  closed), so it gates nothing. For each newly exported symbol under `src/`, check it has a
  caller: `grep -rn '\bN\b' src/ test/ --include='*.ts' | grep -v '<defining file>'`. Zero
  hits means it widens that gap invisibly.
- **Baselines and ratchets.** `scripts/typecheck-baseline.txt` and `eslint-suppressions.json`
  are one-way ratchets. A grown baseline, or a rule folded into a shared selector where its
  budget can be traded for a different violation, defeats the gate.
- **Tests must prove the behavior, not the implementation.** Flag a fix lacking the test the
  issue asked for; flag a test narrowed to a new contract so it passes rather than proving
  the original behavior holds; flag a workflow-YAML assertion that greps text instead of
  parsing the YAML; flag a test that hard-codes a value the thing under test generates.
  Unit tests: interface + fake + `FakeTimer`, no real device or network, under 100ms, and
  never resolving the real file-backed `getDatabase()`.
- **Docs are part of the change.** If the diff removes or adds a capability, the docs that
  advertise it must move too. Stale capability claims in `docs/` were a recurring accepted
  finding this week.

## Step 6 — The generated lens

Only for diffs over 100 lines. Before spawning it, name — in one or two sentences — what
Lens A and Lens B **structurally under-weight for this specific diff**, then write the third
lens to cover exactly that. It is not a free-floating "third perspective"; it is the
complement of the two constants against this change.

Derive it from what the diff actually is. Examples of the reasoning:

- Diff is mostly Kotlin/Swift on-device code → neither constant lens looks hard at
  lifecycle/threading on the device, API-level gating, or `#if DEBUG` release gating of
  debug-only SDK behavior. Make that the third lens.
- Diff is a refactor centralizing many call sites → the constants check the new center, not
  whether **every** old call site moved and behaves identically. Make the third lens an
  exhaustive call-site sweep.
- Diff is a DB/migration change → make it schema/migration semantics: transaction
  enlistment, atomic upsert vs read-modify-write races, column defaults, retention.
- Diff is protocol/wire-format → make it encoding edge cases: non-finite numbers, overflow,
  decode error attribution, and exact wire strings the other side regex-matches.
- Diff spans the TS layer and a runner → make it **version skew**: a new TS layer talking to
  the *old* pinned runner (and vice versa) is the normal state of the world between release
  re-cuts. Does it degrade, or does it break?
- Diff is streaming/media/long-lived resources → make it resource discipline: backpressure on
  stdin/stdout, unbounded buffers, teardown on every exit path, and what happens on EOF.
- Diff is cross-platform (`.bat`/`cmd`, path separators, `os.tmpdir`) → make it the
  non-developer platform: Windows and the macOS CI leg behave differently from local Linux,
  and BSD vs GNU userland differ in `grep`, `sed`, `readlink`, and `date`.

Say in the final report which third lens you chose and why. If you cannot name something the
two constants genuinely under-weight, say that and run two lenses — a manufactured third lens
is worse than none.

## Verification discipline

Give this to every lens subagent.

1. **Ground every finding in code.** Cite `file:line`. Open the file and read the surrounding
   context — never assert from diff text or memory.
2. **Reproduce before asserting a bug.** Run it. If you can't, label the finding
   **unverified** and state exactly how to verify it.
3. **Separate real bugs from environment artifacts.** A tool failing with `Session not found`
   is almost always the daemon-restart session wedge (#2599), not a bug in that tool —
   confirm with a second, unrelated tool before filing.
4. **Check provenance and current state.** `git blame` the lines — don't blame the PR for
   pre-existing code. `git log origin/main -- <file>` to see if it's already fixed or
   superseded.
5. **For a fix PR, verify it closes the ISSUE, not the symptom — and name the false negative
   it introduces.** Ask "what does this change stop catching?" A daemon-dedup fix narrowed to
   the pid-file PID kills the false positive but stops detecting a live cross-worktree rogue
   daemon.
6. **Prefer reuse and existing conventions.** Find the existing helper and recommend *that*.
   One canonical primitive per concern: `IdGenerator`, `Random`, `Backoff`.
7. **Don't paste raw hierarchies.** `observe` results run ~25k tokens. Summarize.

## Architecture (for grounding)

The **MCP server** (`src/`, TS/Bun) forwards tool calls to a **daemon** (`src/daemon/`) that
owns a **DevicePool** and per-platform **CtrlProxy runners**: the Android accessibility-service
APK (`android/control-proxy`) and the iOS XCUITest runner (`ios/control-proxy`), each speaking
a WebSocket protocol (iOS on `:8765`). Apps under test may embed the **AutoMobile SDK** for
in-app capabilities relayed through the runner. Tools are registered in `src/server/index.ts`.

Two gates worth holding in mind while reviewing: every tool is gated by the runner's
`connected` handshake `supportedCommands` (a mismatch between what's advertised and what the
TS layer routes is a real bug), and plan/criticalSection execution resolves via
`getToolForPlan()`, not `getTool()`.

## Working our own PR

When the argument names a PR **we** authored and are actively iterating on, the review is
part of a cycle rather than a one-shot read. In that mode only:

1. Load the `github-cli` skill for the exact commands.
2. Read every review thread with its resolution state (GraphQL `reviewThreads`, since REST
   does not expose `isResolved`), plus failing checks. Prefer per-job logs
   (`gh api …/actions/jobs/<id>/logs`) — a finished job's log is readable while the rest of
   the run is still going. `skipping` and `cancel` buckets are not failures.
3. Triage each unresolved thread against the code. Codex bot findings carry a `P1`/`P2`
   badge; P1 claims to block. Verify the mechanism yourself before acting — and equally,
   before dismissing.
4. Fix what's real. Then **resolve** the thread (`resolveReviewThread`) once the fix is
   pushed. If a finding doesn't apply, reply in-thread with the reason and resolve it.
   Never resolve a thread you haven't actually addressed.
5. Run the lenses as usual. Report their findings to the user — do **not** post them as
   review comments. Your own findings are for the session; only the *existing* threads get
   resolved.
6. Close the loop explicitly: re-run the unresolved-threads query and account for every
   remaining one. Over the past week 46 of 94 codex threads on this repo were merged still
   unresolved, several of them P1 — so "I read them" is not the bar; every thread ends
   fixed-and-resolved, declined-with-a-reason-and-resolved, or named in your summary as
   deliberately left open.

Do this only for a PR we authored. On someone else's PR, read freely and resolve nothing.

## Output

Report in the session, as prose. For **each** finding cover three things:

- your read on the change — is it a real bug, does the fix hold, are you confident or only
  suspicious;
- where it is — `file:line`, and how you checked;
- how to fix it — a named existing helper where one fits, the manual check that would
  confirm it, and any regression or false negative the change risks.

Write findings the way the repo's authors write them:

- **Open with a question when it earns its place — otherwise state the finding flat.** A
  question is right when you genuinely don't understand the code. When the finding is clear,
  say what the bug is in one plain sentence — no `Found a bug`, no severity label. `Nit:` is
  the only label; reserve it for the genuinely minor.
- **State the mechanism as the finding, not under it.** `X does A, so B never happens` —
  every symbol, file, and flag in backticks, an em-dash for the consequence. The mechanism
  *is* the lede; don't bury it under a paragraph of trace.
- **Put the reproduction on its own line**, so it can be run without re-deriving the claim.
- **Say whether it blocks in plain words** — `this should block` or `not a blocker`, as a
  normal clause. No severity track.
- Drop self-certifying parentheticals (`verified by reading code`). The `file:line` carries it.
- When the fix is a concrete line edit, give the replacement lines directly so they can be
  applied.

A worked rewrite — the wall first, the same finding second:

> ❌ I looked into this and I believe there may be an issue where the timer scheduled by
> `scheduleAutoStop` ends up calling `this.stop()` (verified by reading the code), which as
> far as I can tell finalizes the session but does not appear to remove it from `byHandle`,
> so this could potentially be a concern.
>
> ✅ The auto-stop timer calls `this.stop()`, which finalizes the session but never removes
> it from `byHandle` — that delete lives only in `stopAndRemove`, which auto-stop doesn't go
> through, so an auto-stopped session stays registered forever.
> Set `maxDuration`, never call stop — after the timer fires, `byHandle` still holds the entry.

Close with a one-paragraph **summary verdict**, which lenses you ran (and which third lens
you generated, and why), and the single most important thing to verify first. Stay skeptical:
a verified "couldn't reproduce" is more useful than an unverified bug report.
