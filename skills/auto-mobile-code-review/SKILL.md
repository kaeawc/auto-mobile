---
name: auto-mobile-code-review
description: Use this workflow skill to review an AutoMobile change (a PR number or the current branch diff) the way this repo demands — check the PR's real CI, merge and base state first, then run diff-sized review lenses (two fixed, one generated) covering runtime behavior and delivery/enforcement, grounding every finding in file:line and reproducing before asserting. Never posts to GitHub; resolves review threads only on a PR we authored and are actively working.
---

# AutoMobile Code Review

Review a change — a PR (its number passed as the argument) or, with no argument, the current branch's
diff vs `origin/main`. Few verified findings beat many plausible ones.

**Never post to GitHub.** No review comments, reviews, or summaries. Report findings in the
session. The only permitted GitHub write is resolving a review thread, under the conditions in
_Working our own PR_.

Review against the author's intent and the issue the change serves, not the diff in isolation.
Ask rather than assert when genuinely unsure — sometimes you missed something. Name what's
genuinely good in a sentence; never manufacture it.

## Step 0 — Resolve the diff base

Everything below reuses `$BASE`, so establish it first. Which base is correct depends on the
mode, and getting it wrong silently scopes the review to the wrong commits:

```bash
git fetch origin main

# PR mode — the local checkout is usually NOT the PR branch, so HEAD is unrelated to it.
# The leading + forces the update: without it, re-fetching after a force-push is rejected
# non-fast-forward and Step 0 fails before refreshing anything.
git fetch origin "+pull/<PR>/head:refs/remotes/pr/<PR>"
BASE=$(git merge-base "refs/remotes/pr/<PR>" origin/main)
DIFF_ARGS=("$BASE" "refs/remotes/pr/<PR>")   # two endpoints: the PR head, not your tree

# Branch mode — one endpoint, so the diff includes uncommitted work. Naming HEAD as a
# second endpoint would silently drop every working-tree edit.
BASE=$(git merge-base HEAD origin/main)
DIFF_ARGS=("$BASE")
```

Use `"${DIFF_ARGS[@]}"` for every diff below. The distinction is not cosmetic: in branch mode a
two-endpoint diff omits exactly the uncommitted changes the review is supposed to cover.

Both obvious branch-mode alternatives are wrong in a common case: `origin/main...HEAD` (three
dots) is committed work only and reports **zero files** against a dirty tree, silently scoping
the review to nothing; `git diff origin/main` (no dots) picks up uncommitted work but, when the
branch is behind main, folds main's newer commits in as reverse-diffs.

## Step 1 — Establish the change's real state, before reading code

Most escaped defects here were already red on the PR itself. These checks take seconds and
frequently end the review.

```bash
gh pr checks <N> --json name,state,bucket,link
gh pr view <N> --json mergedAt,mergeable,mergeStateStatus,baseRefOid,headRefOid,autoMergeRequest,statusCheckRollup
```

- **Any `failure` blocks — required or not.** Automerge lands PRs over non-required failures:
  [#3969](https://github.com/kaeawc/auto-mobile/pull/3969) auto-merged with `Build Xcode Projects`, `XCTestRunner Simulator Tests`, and `iOS Build`
  red, the pbxproj drift check having worked exactly as designed while the merge gate never
  consulted it.
- **Unfinished checks with automerge armed block equally.** [#4088](https://github.com/kaeawc/auto-mobile/pull/4088) merged five seconds before
  `Swift Packages (Xcode 26.5)` concluded failure. For a merged PR, verify gates concluded
  _before_ the merge:
  ```bash
  gh api repos/kaeawc/auto-mobile/commits/<headRefOid>/check-runs?per_page=100 \
    --jq '.check_runs[] | "\(.name)\t\(.conclusion)\t\(.completed_at)"'
  ```
  Any `completed_at` at or after `mergedAt` means the gate did not gate.
- **Green is only as current as the base it ran on.** Use the Step 0 `$BASE` — the merge-base
  — rather than `baseRefOid`. `$BASE` is computed from the commit graph, so it answers the
  question that actually matters (what was this head built on top of?) without depending on
  when GitHub refreshes a metadata field, it stays correct when a branch integrates main via a
  _merge_ rather than a rebase, and it works identically in branch mode, where there is no
  `baseRefOid` at all. In practice the two agree — measured on
  [#4106](https://github.com/kaeawc/auto-mobile/pull/4106) (both `abd432675`, 11 behind) and
  [#4041](https://github.com/kaeawc/auto-mobile/pull/4041) (both `333c9923e`, 15 behind) — but
  only one of them is correct by construction.

  Cross-check against GitHub's own count, which needs no interpretation at all:

  ```bash
  gh api "repos/kaeawc/auto-mobile/compare/main...<headRefOid>" --jq '.behind_by'
  ```

  If `$BASE` differs from `origin/main` (equivalently, `behind_by > 0`):

  ```bash
  # --format= suppresses commit messages, so only paths print.
  git log "$BASE"..origin/main --name-only --format= -- \
    .github/workflows scripts/all_fast_validate_checks.sh \
    android/build.gradle.kts android/gradle/libs.versions.toml \
    eslint.config.* scripts/typecheck-baseline.txt eslint-suppressions.json | sort -u
  ```

  Any hit means rebase-and-re-run, not approval. [#4016](https://github.com/kaeawc/auto-mobile/pull/4016) went green at 05:44, [#4005](https://github.com/kaeawc/auto-mobile/pull/4005) turned on the
  detekt gate at 05:48, [#4016](https://github.com/kaeawc/auto-mobile/pull/4016) auto-merged at 05:49 — reddening main. Its `Fast Validation` job
  had no `Run detekt` step at all.

- **Run the tests the diff changed.** [#4070](https://github.com/kaeawc/auto-mobile/pull/4070) landed a deterministically-red assertion because a
  refactor moved argv construction and updated one of two sibling tests. Use the Step 0 `$BASE`, so uncommitted test edits are included, and guard the empty case explicitly rather
  than relying on `xargs -r` (GNU-only on older macOS and other BSDs):
  ```bash
  changed_tests=$(git diff --name-only "${DIFF_ARGS[@]}" -- 'test/**/*.test.ts')
  [ -n "$changed_tests" ] && bun test $changed_tests
  ```

Pull the failing _job's_ log, not the whole run — a finished job's log is readable while the run
continues (see `github-cli`).

**Classify each red result before treating it as a finding**: PR-caused, pre-existing on main,
transient/infrastructure, or unproven — grounded in the job log, changed paths, and current
`origin/main`. Never recommend a code change for an unrelated or unproven failure, but do name
it in the summary. Flag one check name appearing twice on the head SHA with different
conclusions: a stale cancelled run beside a fresh green one silently parks automerge.

## Step 2 — Scope and size the diff

`git fetch origin main` first. With a PR: `gh pr view <N> --json
title,body,headRefOid,files,closingIssuesReferences`, `gh pr diff <N>`, then read the changed
files on disk and the issue it claims to close — a reviewed head can differ from what
squash-**merged**, and a "fix" PR can merge test-only, so check `git log origin/main` for what
actually landed. With no argument, review committed _and_ uncommitted work; read changed files
in full, since the hunk lies by omission.

Size the diff with the Step 0 `${DIFF_ARGS[@]}`, excluding lockfiles and generated
artifacts:

```bash
git diff --numstat "${DIFF_ARGS[@]}" -- . \
  ':(exclude)**/*.lock' ':(exclude)bun.lockb' ':(exclude)schemas/**' \
  ':(exclude)**/project.pbxproj' ':(exclude)eslint-suppressions.json' \
  | awk '{a+=$1; d+=$2} END {print a+d" changed lines across "NR" files"}'
```

Reuse `${DIFF_ARGS[@]}` for every later diff, sanity-check the file count, and report how far behind main
the branch is (`git rev-list --count HEAD..origin/main`) — Step 1's stale-base check applies to
branch reviews too.

## Step 3 — Pick lenses by size

A lens is a review pass with a fixed field of view. Run each as a **separate subagent**, then
merge and dedupe yourself.

- **Over 100 changed lines** → all three: Runtime Behavior, Delivery & Enforcement, and one
  generated lens (Step 6).
- **100 or fewer** → skip the generated lens. Run whichever constant lens the diff belongs to;
  both when it straddles them (a `src/` change that also edits a workflow or guard script always
  straddles).
- Trivial diffs — version bump, comment, string with no behavioral reach — get one lens and a
  short answer.

Brief each subagent with: the diff, the issue it closes, _Verification discipline_ below, that
lens's checklist verbatim, and this isolation rule.

### Lens subagents must not mutate the working tree

Not advisory. A lens told to "review PR #N" will reach for `git checkout` and destroy the
invoking session's state; this repo has ~100 worktrees on one object store, so the blast radius
exceeds the reviewer. Put this in every brief:

> Do not run `git checkout`, `git switch`, `git stash`, `git reset`, `git restore`, or
> `git branch -f` in this worktree. It is not yours and other work depends on its state.

Read PR content without checking anything out:

```bash
gh pr diff <N>                                       # the diff
gh pr view <N> --json files,title,body               # metadata
git fetch origin pull/<N>/head:refs/remotes/pr/<N>   # remote-tracking ref, no checkout
git show refs/remotes/pr/<N>:<path>                  # any file at the PR head
```

A lens needing a populated tree makes its own and removes it:

```bash
mkdir -p scratch
git worktree add "scratch/lens-<N>" refs/remotes/pr/<N>
git worktree remove --force "scratch/lens-<N>"
```

A fresh worktree has **no `node_modules`**, so anything resolving an npm dependency (the
TypeScript-AST guards under `scripts/`, `bun test`) fails there for environmental reasons that
look exactly like real findings; symlinking `node_modules` in is not reliably enough either.
Install them in the throwaway worktree instead:

```bash
git worktree add "scratch/lens-<N>" refs/remotes/pr/<N>
(cd "scratch/lens-<N>" && bun install --frozen-lockfile)
```

Do **not** copy a PR-head file into the caller's checkout and restore it afterwards. That
mutates a tree you do not own — it can clobber uncommitted work in branch mode, and if the check
aborts partway the file is left modified — which is the very thing this section exists to
prevent. If installing is too slow for the check at hand, label the finding **unverified** and
give the exact command to run, rather than mutating someone else's worktree to get an answer.

## Step 4 — Lens A: Runtime Behavior

_Does the changed code do the thing, on every path a user can reach?_

- **Reachability.** The most common miss here: new logic added to one converter/executor while
  the public tool call routes through another. Trace each new function or branch _backwards_ to
  the MCP entry point and prove a user request reaches it — grep for the caller. Seen as heading
  promotion added to `CtrlProxyHierarchy.convertToViewHierarchyResult` while `observe` goes
  through `ViewHierarchy.getiOSViewHierarchy` → `convertXCTestHierarchy`, and a
  VoiceOver-unsupported result made unreachable because `lookFor` swipes divert to
  `ScrollUntilVisible`.
- **Ordering around `await`.** Read every added `await` and ask what happens during it: a
  listener or error handler registered _after_ the first await loses early events; an await
  inserted between a check and its `set` opens a TOCTOU window.
- **Error and degradation paths.** Spawn failure, EOF, malformed cached metadata, download
  failure, abort mid-flight. Every `catch` must throw `ActionableError`, log-then-return a typed
  failure, or log-at-debug-and-continue _with a comment saying why it's safe_
  (`CLAUDE.md`/`AGENTS.md`). Flag silent swallows and optimistic success (`success ?? true`).
- **Cross-layer shape contracts.** Runners emit the **raw** hierarchy; the TS layer _adds_
  fields. Android pushes `AccessibilityHierarchy` where `hierarchy` is already the root, unlike
  the MCP wrapper shape. Code walking one shape and receiving the other fails silently — verify
  which the actual caller passes.
- **Overrides, injection, persistence.** Does an injected data-dir/env override survive the
  changed path, or does a default overwrite it? Per-device `getInstance(device)` singletons hold
  instance-level caches — verify a cache fix persists _where it is read_.
- **Concurrency and identity.** Two concurrent calls for one device; cleanup deleting a
  _replacement_ resource; a callback firing for a superseded encoder. Guard by identity, not
  presence.
- **Process spawning.** `spawn(..., { shell: true })` concatenates `args` for the shell instead
  of preserving argv boundaries, so any dynamic value — an AVD name, a path — can carry shell
  syntax. Recurred all week across Windows `.bat`/`cmd` paths. Prefer a non-shell executable
  path; otherwise quote explicitly.
- **Relative paths under the detached daemon.** The daemon `chdir`s to a stable cwd ([#2564](https://github.com/kaeawc/auto-mobile/pull/2564)), so
  user-supplied relative paths must go through `resolvePathFromDaemonLaunchWorkingDirectory`.
  Grep for raw `fs.stat`/`readFile`/`copyFile` on an argument-derived path — this caught
  `putAppFile`'s `sourcePath`.

## Step 5 — Lens B: Delivery & Enforcement

_Does the change ship, and does the thing enforcing it work?_ A correct-looking diff here
routinely ships nothing.

- **Runner source changed ⇒ re-cut the release artifact.** If the diff touches
  `ios/control-proxy/Sources/**` or `android/control-proxy/**`, the daemon still downloads the
  pinned released runner. Unless `src/constants/release.ts` checksums change in the same PR (or
  a re-cut is explicitly sequenced), the feature is **undeliverable** and the issue is not
  closed. Blocking. Check with the Step 2 `$BASE`, not `origin/main...HEAD`, so an uncommitted
  runner edit still trips it: `git diff --name-only "${DIFF_ARGS[@]}" | grep -E
'^(ios|android)/control-proxy/'`, then whether `src/constants/release.ts` is in the same diff.
- **New Swift file ⇒ regenerate the Xcode project.** A file under `ios/control-proxy/Sources/**`
  absent from the committed `ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj` is not
  compiled on a normal checkout. `grep -c '<NewSymbol>'` against the pbxproj returning zero means
  `xcodegen generate` was not run and committed.
- **Generated artifacts drift silently.** `schemas/tool-definitions.json` comes from
  `scripts/generate-tool-definitions.ts`, whose registered `register*Tools` categories must match
  `src/server/index.ts`. Flag production tools missing from the artifact and daemon-only tools
  falsely advertised. The flattener also emits JSON-Schema `if/then` (`postNotification` requires
  `appId` iff iOS) — verify the host _accepts_ it, not just that it generates, and that `appId`
  aliases (`bundleId`, `packageName`) are coerced, including nested
  `systemTray.notification.appId`.
- **Debug-only SDK behavior must be `#if DEBUG`-gated on the enforcement path.** Network-mock
  enforcement, DB inspector, and highlight overlay must be unshippable in release. Check the
  enforcement short-circuit, not the rule-setting route — the iOS network mock had its setter
  gated while enforcement sat outside `#if DEBUG`.
- **A new guard must actually guard.** The `scripts/check-*` ratchets are the single largest
  source of accepted findings:
  - Does the pattern match **every** banned form? Template literals (`` `simctl ${x}` ``),
    array/argv form, multiline argv, `exec`/`execSync`, `spawnSync`, destructured
    `const {execFile} = require('child_process')`, and `/bin/sh -c` wrappers are what it has
    repeatedly missed. Write a hostile example of each and run the guard against it.
  - Does it **fail closed**? A guard that cannot compute its diff base must exit non-zero.
    `origin/main` is absent in a depth-1 `actions/checkout`, so one that assumes it passes
    silently on every PR.
  - Is it **registered** in `scripts/all_fast_validate_checks.sh` via `add_check` with a
    **unique** name? Two checks sharing a name collide on `$run_dir/${name}.log`.
  - Is its file-selection predicate too wide? `check-android-emulator-boundary.ts:81` selects
    with `/emulator/i` against the whole source _including comments_, so adding that word in a
    comment pulls a file into scope and flags pre-existing code.
- **CI job wiring**, when the diff touches `.github/workflows/**`:
  - A new job absent from the required roll-up removes a merge blocker rather than adding one —
    trace it to the gate job's `needs:`.
  - Does the job install what the changed script needs? A BATS test shelling into a Bun script
    fails on a `bats-tests` job that never sets up Bun.
  - Do `if:` conditions still carry their guard? `!cancelled()` without the build gate re-enables
    a leg meant to be gated.
  - Flags and matrix values must survive YAML → shell — a JSON-array input joined into a string,
    or gradle flags losing their spaces, silently drops every flag. Hand-simulate the quoting; a
    GitHub expression pasted into a quoted shell string fails differently from one passed as an
    argument.
  - **A new path filter can silently un-gate a job.** When a job gains `if:
needs.detect-changes.outputs.<x> == 'true'`, compare the `dorny/paths-filter` globs against
    the paths the script _it runs_ treats as significant. [#4026](https://github.com/kaeawc/auto-mobile/pull/4026) gated detekt on a filter omitting
    `android/gradle/wrapper/**`, which `scripts/android/detekt_scope.sh` treats as a full-scope
    trigger — so a wrapper bump skipped detekt entirely instead of failing open.
- **Post-merge-only workflows are invisible to PR CI**: `merge.yml`, `nightly.yml`,
  `dead-code-detection.yml`, `release.yml`, `prepare-release.yml`,
  `record-screenshot-baselines.yml`. The reusable builders `build-control-proxy-apk.yml`,
  `build-ctrl-proxy-ios-ipa.yml`, and `build-video-server-jar.yml` are `workflow_call` only,
  referenced solely by nightly/prepare-release/release, so APK/IPA signing, jar reproducibility,
  and sha256 computation are **never** exercised pre-merge. Merge-only jobs with no PR
  counterpart: `publish-android-libraries-snapshot`, `deploy-docs`, the coverage jobs,
  `benchmark-context-thresholds`, `update-readme-badges`; ktfmt and detekt run full-tree on merge
  but scoped or path-gated on PRs. When the diff touches `.github/**` or
  `scripts/(ci|android|ios)/**`, reason statically and confirm the destination leg is green
  (`gh run list --workflow=nightly.yml -L 5`) — landing on an already-red leg hides the
  regression.
- **New exports need a consumer.** `dead-code-detection.yml` is weekly-only and has been red for
  months (271 findings against a threshold of 10; twelve duplicate issues filed and closed), so
  it gates nothing. For each new exported symbol under `src/`:
  `grep -rn '\bN\b' src/ test/ --include='*.ts' | grep -v '<defining file>'`. Zero hits widens
  that gap invisibly.
- **Baselines are one-way ratchets.** A grown `scripts/typecheck-baseline.txt` or
  `eslint-suppressions.json`, or a rule folded into a shared selector where its budget can be
  traded for a different violation, defeats the gate.
- **Tests must prove behavior, not implementation.** Flag a fix lacking the test the issue asked
  for; a test narrowed to a new contract so it passes; a workflow-YAML assertion that greps text
  instead of parsing YAML; a test hard-coding a value the thing under test generates. Unit tests:
  interface + fake + `FakeTimer`, no real device or network, under 100ms, never resolving the
  real file-backed `getDatabase()`.
- **Docs are part of the change.** Capability added or removed ⇒ the docs advertising it move
  too. Stale claims in `docs/` were a recurring accepted finding.

## Step 6 — The generated lens

Diffs over 100 lines only. First name, in a sentence or two, what Lens A and Lens B
**structurally under-weight for this diff**, then write the third lens to cover exactly that. It
is the complement of the two constants, not a free-floating third opinion.

- Mostly Kotlin/Swift on-device → device lifecycle/threading, API-level gating, `#if DEBUG`
  release gating.
- A refactor centralizing call sites → the constants check the new center, not whether **every**
  old call site moved and behaves identically; make it an exhaustive call-site sweep.
- DB/migration → transaction enlistment, atomic upsert vs read-modify-write races, column
  defaults, retention.
- Protocol/wire-format → non-finite numbers, overflow, decode error attribution, exact wire
  strings the other side regex-matches.
- TS layer plus a runner → **version skew**: a new TS layer against the old pinned runner (and
  vice versa) is the normal state between re-cuts. Degrade or break?
- Streaming/media/long-lived resources → backpressure on stdin/stdout, unbounded buffers,
  teardown on every exit path, EOF.
- Cross-platform (`.bat`/`cmd`, path separators, `os.tmpdir`) → Windows and the macOS CI leg
  versus local Linux; BSD vs GNU `grep`, `sed`, `readlink`, `date`.

Report which third lens you chose and why. If you cannot name a genuine gap, say so and run
two — a manufactured third lens is worse than none.

## Verification discipline

Give this to every lens subagent.

1. **Ground every finding in code.** Cite `file:line`; open the file and read around it. Never
   assert from diff text or memory.
2. **Reproduce before asserting.** If you can't, label it **unverified** and state exactly how to
   verify.
3. **Before you call a claim refuted, check that your test could have found it.** Two questions,
   both of which have burned this repo:
   - _Does the test discriminate?_ If both the claim and its negation predict what you observed,
     you learned nothing. A sample of three PRs that were all rebased cannot distinguish
     `baseRefOid` from the merge-base, because those only diverge when a branch integrates main
     via a merge.
   - _Does your environment match the claim's scope?_ A claim about "macOS/BSD" is not tested by
     one macOS 15.6 laptop, and a claim about a CLI's behavior is not settled by the one version
     you happen to have. State the version or platform you tested, so the limit is visible.
4. **Refuting costs more than accepting, so it carries the higher burden.** Wrongly rejecting a
   real finding leaves a live bug; wrongly accepting a bad one costs a small unnecessary change.
   When the evidence is thin, take the change.
5. **A wrong mechanism does not make a wrong suggestion.** Verify the claim and evaluate the
   recommendation _separately_ — a reviewer can be wrong about why and right about what. Twice
   this week a finding's stated mechanism was demonstrably false while its proposed change was
   the better design anyway (`xargs -r`, `baseRefOid`). If the suggestion stands on its own
   reasoning, take it and say plainly that the stated reason did not hold.
6. **Separate real bugs from environment artifacts.** `Session not found` is almost always the
   daemon-restart session wedge ([#2599](https://github.com/kaeawc/auto-mobile/issues/2599)) — confirm with a second, unrelated tool first.
7. **Check provenance.** `git blame` the lines; don't blame the PR for pre-existing code.
   `git log origin/main -- <file>` to see if it's already fixed or superseded.
8. **For a fix PR, verify it closes the ISSUE, not the symptom — and name the false negative it
   introduces.** Ask what the change stops catching: a daemon-dedup fix narrowed to the pid-file
   PID kills the false positive but stops detecting a live cross-worktree rogue daemon.
9. **Prefer existing helpers.** One canonical primitive per concern: `IdGenerator`, `Random`,
   `Backoff`.
10. **Don't paste raw hierarchies** — `observe` results run ~25k tokens. Summarize.

## Architecture

The **MCP server** (`src/`, TS/Bun) forwards tool calls to a **daemon** (`src/daemon/`) owning a
**DevicePool** and per-platform **CtrlProxy runners**: the Android accessibility-service APK
(`android/control-proxy`) and the iOS XCUITest runner (`ios/control-proxy`), each speaking a
WebSocket protocol (iOS on `:8765`). Apps under test may embed the **AutoMobile SDK** for in-app
capabilities relayed through the runner. Tools register in `src/server/index.ts`.

Two gates to hold in mind: every tool is gated by the runner's `connected` handshake
`supportedCommands` (a mismatch with what the TS layer routes is a real bug), and
plan/criticalSection execution resolves via `getToolForPlan()`, not `getTool()`.

## Working our own PR

When the argument names a PR **we** authored and are actively iterating on:

1. Use `github-pr-feedback` for the feedback ledger and `check-ci` for workflow state. Don't
   hand-roll either — feedback lives on **four** separate paginated surfaces (conversation
   comments, review submissions, inline comments, GraphQL review threads) and only the last
   carries resolution state.
2. Scope everything to `headRefOid` and record it. Checks, threads, and comments are all relative
   to the SHA they were made against, so after any push, re-collect from the new head before
   resolving anything or calling CI green.
3. Triage each unresolved thread with a disposition: `fix`, `wrong reason, right change`,
   `already addressed`, `not actionable`, `duplicate`, `ambiguous`, or `out of scope`. Codex
   findings carry a `P1`/`P2` badge; P1 claims to block. Verify the mechanism before acting
   _and_ before dismissing — but keep the two judgements apart: `wrong reason, right change`
   exists because a false mechanism and a good suggestion arrive together often enough that
   collapsing them into `not actionable` loses real fixes. An `isOutdated` thread is a prompt to
   check whether the current head fixed the behavior, not a reason to discard it.
4. **Resolve every thread you triaged** (`resolveReviewThread`) — that is what addressing one
   means. A finding you fixed and a finding you verified and declined are both handled; only
   the reason differs, and the reason goes to the user in-session, not to GitHub. For a `fix` or
   a `wrong reason, right change`, resolve once it is committed **and pushed**, validation
   passed, and the fresh head still contains it — and for the latter, say which part of the
   stated reasoning did not hold, so a bad rationale does not become precedent. For `already addressed`, `not actionable`, `duplicate`, or `out of scope`,
   resolve directly. Either way the PR must be open, authored by the authenticated user
   (`gh api user -q .login`), and the resolution must answer _that_ thread. The one exception
   is `ambiguous` — if you could not tell whether the finding is real, leave it open and ask.
   On a merged/closed PR, treat unresolved threads as historical dispositions — don't push,
   resolve, or re-run without asking.
5. Run the lenses as usual and report their findings to the user. Never post them. Only
   _existing_ threads get resolved.
6. Close the loop: re-run the unresolved-threads query and expect it to come back empty. Over
   one recent week, 46 of 94 codex threads here merged unresolved, several P1 — so "I read them"
   is not the bar. Anything still open at the end is a thread you genuinely could not resolve,
   and it needs a sentence in your summary saying why.

Only for a PR we authored. On someone else's, read freely and resolve nothing.

## Output

Report in the session as prose. For each finding: your read (real bug or suspicion, does the fix
hold), where it is (`file:line`, how you checked), and how to fix it (a named existing helper,
the manual check that would confirm it, and any regression or false negative it risks).

- **Open with a question only when it earns its place** — genuine confusion about the code.
  Otherwise state the finding flat. No `Found a bug`, no severity label. `Nit:` is the only
  label, for the genuinely minor.
- **The mechanism is the lede.** `X does A, so B never happens` — symbols, files, and flags in
  backticks, an em-dash for the consequence. Don't bury it under a paragraph of trace.
- **Put the reproduction on its own line** so it runs without re-deriving the claim.
- **Say whether it blocks in plain words** — `this should block` or `not a blocker`, as a normal
  clause.
- Drop self-certifying parentheticals (`verified by reading code`); the `file:line` carries it.
- Give replacement lines directly when the fix is a concrete line edit.

The wall first, the same finding second:

> ❌ I looked into this and I believe there may be an issue where the timer scheduled by
> `scheduleAutoStop` ends up calling `this.stop()` (verified by reading the code), which as far
> as I can tell finalizes the session but does not appear to remove it from `byHandle`, so this
> could potentially be a concern.
>
> ✅ The auto-stop timer calls `this.stop()`, which finalizes the session but never removes it
> from `byHandle` — that delete lives only in `stopAndRemove`, which auto-stop doesn't go
> through, so an auto-stopped session stays registered forever.
> Set `maxDuration`, never call stop — after the timer fires, `byHandle` still holds the entry.

Close with a one-paragraph verdict, which lenses you ran (and which third you generated, and
why), and the single most important thing to verify first. A verified "couldn't reproduce" beats
an unverified bug report.
