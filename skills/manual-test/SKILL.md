---
name: manual-test
description: "Run one AutoMobile manual-test iteration: from a start point (commit, milestone/tag, or date), rebuild ALL components, restart the daemon with the right flags, and verify that closed issues and merged PRs actually fix their bugs / deliver their specced features on current HEAD by exercising tool calls on an Android emulator and iOS simulator. Use when asked to retest landed work, verify a release, or manually test what changed."
---

# AutoMobile Manual Test Iteration

Verify that the work claimed done since a starting point is **actually** done on
the current HEAD of `main` — reproduce-then-confirm each bug fix, exercise each
specced feature end to end, and sweep the changed tool surface for regressions.
Drive a real Android emulator and iOS simulator. Ground every PASS in an observed
field or device-side ground truth, never the tool's self-reported `success`.

Device work is **sequential — one device at a time (no parallelism yet)**. Do
Phase A (Android) fully, then Phase B (iOS). Delegate breadth to **one** subagent
at a time to conserve context; never let two actors drive devices at once.

## Phase 0 — Scope from the start point

1. **Get the start point.** Accept a commit SHA, a tag/milestone, or a date. If
   none was given, ask for one (offer the last release tag as default:
   `git tag | sort -V | tail`). Resolve it to a git ref `<START>`.
2. **Enumerate landed work** in `<START>..origin/main`:
   - Merged PRs: `gh pr list --state merged --search "merged:>=<DATE>" --json number,title,closingIssuesReferences` (or by commit range).
   - Closed issues: `gh issue list --state closed --search "closed:>=<DATE>" --json number,title,labels`.
   - Map each to a **type**: _bug-fix_ (reproduce → confirm fixed) or _feature/spec_ (exercise → confirm the output/effect exists).
3. **Scope the changed tool surface** for regression risk:
   `git log --oneline <START>..HEAD | grep -viE "README test count badges|deps"` and
   `git diff --stat <START>..HEAD -- src/`. Map changed non-test source files to the
   MCP tools they implement (`src/features/**`, `src/server/*Tools.ts`, `schemas/tool-definitions.json`).
4. Note which items are **runner-side** (need an APK/runner rebuild — see Phase 1)
   vs **flag-gated** (need `--embedded-sdk`/`--network-mockable` — see Phase 2) vs
   **blocked** (need a physical iOS device or an on-sim SDK app — see Phase 3).
5. Produce a checklist: `item # | type | tool(s) | needs (rebuild/flag/device) | observable to check`.

## Phase 1 — Rebuild ALL necessary components

> **CRITICAL GOTCHA — stale dist masked by the version string.** The daemon
> reports `0.0.x+g<HEAD>` computed from `git rev-parse HEAD` at **startup**, NOT
> from the compiled code. A dist built days ago will still print the current HEAD
> and look fresh. **Never trust the version string.** Verify freshness by the
> `Daemon Build Identity` build hash (changes when dist changes) and/or
> `dist/src/index.js` mtime. Always rebuild.

1. **Sync git.** Rebase this worktree on `origin/main`, then fast-forward the
   **main checkout the daemon runs from** (`~/kaeawc/auto-mobile`, `git pull --ff-only`).
   The daemon's entry script is that checkout's `dist/src/index.js`, and the MCP
   proxy must match its build — keep them on the same commit.
2. **TS dist + schemas (always):** `bun run build` then
   `bash scripts/update-tool-definitions.sh`. Confirm the dist mtime moved and,
   for a specific fix, grep the compiled `dist/src/index.js` for a token from the
   change.
3. **Android ctrlproxy APK — rebuild if any `android/control-proxy/**` (runner)
   changed.** Runner-gated features (e.g. occlusion `occludedByViewId`, new
   extractor fields) will NOT appear until the APK is re-cut, even with fresh TS:
   `cd android && ./gradlew :control-proxy:assembleDebug` →
   `android/control-proxy/build/outputs/apk/debug/control-proxy-debug.apk`.
4. **iOS runner — rebuild if any `ios/control-proxy/**` changed:**
   `scripts/ios/ctrl-proxy-build-for-testing.sh` → `/tmp/automobile-ctrl-proxy/Build/Products`.
5. **Playground SDK app — only if testing SDK features.** Use the **standard**
   Gradle output `android/playground/app/build/outputs/apk/debug/app-debug.apk`.
   Do NOT use `android/build/grit/**` or `android/build/gojvm/**` variants — they
   are incomplete (missing `androidx.startup` resources) and crash on launch with
   `NoClassDefFoundError: androidx.startup.R$string`.

## Phase 2 — Restart the daemon with the right flags

> **Multi-worktree daemon churn.** Other worktrees/sessions spawn competing
> daemons on the shared socket `/tmp/auto-mobile-daemon-501.sock`. They cause
> build-skew rejects and the CLI's daemon auto-restart can replace your
> flag-configured daemon with a flagless one. Kill ALL daemons first and re-check
> for strays after starting yours. If a competing daemon keeps respawning,
> flag-gated (SDK) testing is **BLOCKED: multi-worktree daemon churn** — record it
> and move on rather than fighting it.

1. `ps aux | grep 'index.js --daemon-mode' | grep -v grep | awk '{print $2}' | xargs -r kill -9; rm -f /tmp/auto-mobile-daemon-501.sock`.
2. Start ONE daemon from the fresh dist with the env + flags the run needs:
   - `AUTOMOBILE_CTRL_PROXY_APK_PATH=<fresh apk>` to use the freshly-built Android
     runner (also uninstall+reinstall the APK on the emulator first for a runner fix);
     otherwise `AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED=true` to keep the
     installed one and avoid the ~30s blocking download (#2590).
   - **Do NOT set `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH`.** It wants an `.ipa`
     **file**, and `scripts/ios/ctrl-proxy-build-for-testing.sh` produces no `.ipa`
     — only a derived-data tree. The failure mode depends on whether the runner
     **service is already running and responding**, which is _not_ the same as
     "artifacts are cached". `setup()` short-circuits only on a live health probe
     (`isRunning()`, `src/utils/IOSCtrlProxyManager.ts:988-995`, and the
     `attemptedSetup` reuse at `:966` which also re-probes via `isAvailable()`);
     cached artifacts alone never short-circuit.
     - **Service already running / responsive** — the builder is never consulted, so
       the override is **bypassed with no diagnostic** and you attribute results to a
       local build that never ran.
     - **Anything else, including cached-but-not-running** — setup reaches
       `needsRebuild()` (`src/utils/IOSCtrlProxyManager.ts:1001`), which returns true
       whenever an override is set (`src/utils/IOSCtrlProxyBuilder.ts:393-396`).
       `build()` then calls `ensureBundleDownloaded()`, which throws
       `CtrlProxy bundle override is not a file`
       (`src/utils/IOSCtrlProxyBuilder.ts:741-742`); that becomes a failed build
       result (`:485-495`) and `setup()` returns the failure
       (`src/utils/IOSCtrlProxyManager.ts:1020-1028`). There is **no** fallback to
       cached artifacts — CtrlProxy iOS **setup fails loudly**.

     So: if iOS setup fails with `bundle override is not a file`, unset the override;
     if it appears to work, a runner was already live — confirm which runner actually
     served the call (ref
     [#4221](https://github.com/kaeawc/auto-mobile/issues/4221)). The build script
     writes to the **default** derived-data path (`/tmp/automobile-ctrl-proxy`), so
     no path env var is needed; only for a non-default location set
     `AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA=<derived-data-root>` (the root — the
     code appends `Build/Products` itself).

   - **Set `AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD=true` (or pass
     `--skip-ctrl-proxy-download`) when testing a locally built iOS runner.**
     Landing the build in the default derived-data path is **not** sufficient on
     its own: `needsRebuild()` also consults release metadata cached **separately**
     in `~/.automobile/ctrl-proxy-ios/ctrl-proxy-ios-bundle.json`, which the build
     script never writes (`src/utils/IOSCtrlProxyBuilder.ts:398-433`). These states
     are only reached when the service is **not** already running (a live runner is
     reused and the builder never runs at all). Three of them download the
     **released** runner and extract it straight over
     `/tmp/automobile-ctrl-proxy`, destroying your local build without a warning:
     - **fresh host / cleared cache** — metadata missing ⇒ "metadata missing, need
       download";
     - **changed `AUTOMOBILE_VERSION`** — expected checksum no longer matches the
       cached metadata ⇒ "checksum mismatch, need download" (and if the pinned
       version is not in the checksum registry, setup fails closed instead);
     - **physical-device target** — the baked device app hash never matches a local
       build ⇒ "app hash mismatch, need download". (Simulator targets have no
       expected app hash, so this one does not fire there.)

     Only when metadata is already present **and** matches the current version does
     the "no env var" path reuse your local build. The skip flag short-circuits
     `needsRebuild()` before any of those checks
     (`src/utils/IOSCtrlProxyBuilder.ts:379-382`), so it is the reliable switch — and
     it is the only thing that also covers the daemon-startup **prefetch**
     (`IOSCtrlProxyBuilder.prefetchBuild()`, `src/index.ts:538`), which runs
     `needsRebuild()`/`build()` in the background independently of `setup()` and can
     overwrite your local build before you make a single tool call.
     **Caveat — it is process-wide, not iOS-only:** it also suppresses the Android
     CtrlProxy download/install, so install the freshly built APK on the emulator
     yourself (`adb install -r <fresh apk>`) before starting the daemon, or run the
     Android leg in a separate daemon without the flag.

   - **Serve a locally built iOS runner (the reliable procedure).** `SKIP` +
     `IOS_DERIVED_DATA` alone are **not** enough for iOS: they stop the released
     runner from overwriting your build, but they do **not** make the daemon
     launch your build — a second gate rejects it. Before launch the daemon
     re-hashes the runner binary and refuses on any mismatch against the
     release-pinned `runnerSha256`
     (`assertRunnerBinaryHash()`, `src/utils/IOSCtrlProxyBuilder.ts`), and a
     locally built runner **always** hashes differently:

     ```
     CtrlProxy runner binary SHA256 mismatch (pre-launch) for simulator.
     Expected: <pinned>, Got: <your local build>. Refusing to launch ...
     ```

     Two supported ways past this — **prefer the first**:
     1. **First-class local-build mode (recommended).** Set
        `AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD=true`. The daemon then derives
        the expected SHA from your freshly built runner, pins it, and re-verifies
        against that pinned value before launch (so a TOCTOU swap still fails
        closed) — no SHA to hand-copy. It logs a loud WARN that the release-pinned
        guard is relaxed for the run. Run **without** `AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD`
        so the builder actually runs, and point
        `AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA=<derived-data-root>` at your build.
     2. **Explicit pinned SHA (manual).** Set
        `AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256=<64-hex>` (and
        `AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256_TARGET=runner|xctest` to pick the
        binary; defaults to the release's target). This keeps the integrity gate
        active against _your_ value. The catch is chicken-and-egg: you learn the
        SHA only by launching once and reading the `Got:` value from the mismatch
        error, then re-launching with it. An explicit value here **overrides**
        local-build mode, so unset it if you want auto-derivation.

     **SKIP-flag interaction:** with `AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD=true` the
     iOS prefetch is disabled and the builder never launches a local runner — the
     daemon just **reuses whatever runner is already live** on the port (often one
     owned by another session's `bunx auto-mobile`), so freeing the port then
     falls through to the launch/guard path above. For local-build mode, start
     **without** the skip flag. If the daemon reuses a runner it did not launch it
     now logs a loud WARN (`Reusing an external CtrlProxy runner this daemon did
not launch`) — treat that as a signal to confirm which runner served the call.

   - **Verify which runner actually served the call** — `grep xctestrun <daemon-log>`
     for the path, and `grep 'need download\|Downloading CtrlProxy bundle' <daemon-log>`
     to confirm the released bundle did _not_ replace your build. Also
     `grep 'Local-build mode' <daemon-log>` to confirm your local runner's derived
     SHA was trusted, and `grep 'Reusing an external CtrlProxy runner' <daemon-log>`
     to catch a stale/foreign runner silently serving.
   - `--embedded-sdk` — required for `sqlQuery`, `setPreference`/`getPreference`,
     in-app `highlight` (registration is **daemon-side**; the CLI must pass the same
     flag so the reuse check matches, else it restarts the daemon).
   - `--network-mockable` — required for `mockNetwork` / network error-simulation.
   - To test the **gated-OFF** assertion (criticalSection/executePlan hidden
     without debug), start WITHOUT `--debug`/`--embedded-sdk`.
3. Wait ~10-12s, then confirm exactly one daemon and that it carries your flags
   (`ps -o command=`).

> **MCP proxy build-skew → CLI fallback.** After any daemon restart the connected
> MCP proxy is rejected by the build-skew guard (`client build != daemon build`).
> In a fresh interactive Claude session the proxy auto-respawns from the current
> dist and MCP tools work again. On a shared multi-session machine it stays stale.
> **Fallback: drive tools via the CLI** — a fresh, build-matched client:
> `bun /path/to/dist/src/index.js [--embedded-sdk --network-mockable] --cli <tool> --<param> <value>`.
> Nested-object params must be JSON: `--selector '{"text":"Settings"}'`; booleans
> `--raw true`. The result JSON is the string at `content[0].text`
> (`python3 -c "import json;print(json.loads(open('F').read())['content'][0]['text'])"`).
> If output begins with `Restarting daemon...` a competing daemon caused churn —
> retry once; if persistent, mark the tool BLOCKED.

## Phase 3 — Exercise tool calls (Android, then iOS)

Make the target device active and leave the other alone. For **each** checklist item:

- **Bug-fix items:** reproduce the **original failure condition** first, then
  confirm it no longer reproduces. Capture the concrete observable AND device-side
  ground truth — e.g. `adb shell cmd locale get-app-locales <pkg>` for locale,
  `adb -s <id> emu avd name` + `getprop sys.boot_completed` for startDevice
  correlation/readiness, `dumpsys notification` for postNotification, raw runner
  output for observe fields. A tool returning `success:true` is not proof.
- **Feature/spec items:** exercise the new tool/param and assert the actual output
  field or effect exists (e.g. `occludedByViewId` populated with a real node id;
  `tapOn.index` selects distinct instances; per-app locale actually set).
- **Regression sweep:** run the changed-surface tools (observe, tapOn, swipeOn,
  inputText/clearText, pressButton, dragAndDrop, pinchOn, rotate, launch/terminate,
  device state, navigation) and confirm well-formed output on the fresh runners.

**Known blockers — record, don't fight:**

- iOS **in-app SDK features** (sqlQuery/execute_sql, mockNetwork error-sim, in-app
  highlight) need an SDK-embedded app **installed on the sim** — none ships; BLOCKED
  unless you install one.
- **Physical-device** items (pressButton volume/power working-path,
  changeLocalization lockdown, get/setAppPermissions physical reset, shake-on-physical):
  BLOCKED when no physical iOS device is attached.
- SDK-flag tools under **multi-worktree daemon churn** (Phase 2).

**Device gotchas:**

- Never `pressButton power` on Android — it sleep-locks the emulator behind a keyguard.
- `rotate`: test on a landscape-capable screen; iPhone springboard/Settings are
  portrait-locked, which reads as a false "rotate broken".
- `startDevice`: expect readiness churn; the `DisconnectMonitor` may auto-restart a
  killed emulator; with ≥2 emulators running, sanity-check the returned `deviceId`
  against `adb emu avd name` ground truth.
- `postNotification` on Android needs the SDK app foregrounded AND declaring
  `POST_NOTIFICATIONS` (API 33+); the playground fixture declares no permissions, so
  end-to-end delivery is a fixture gap, not a tool bug.
- iOS observe can transiently return an empty hierarchy right after a cold sim boot;
  retry once.

## Phase 4 — Report, file, and confirm

1. Write a per-item table: `Item # | Type | Platform | FIXED / PASS / NOT-FIXED / REGRESSED / BLOCKED | Evidence (the field checked)`.
2. **File a GitHub issue** for every regression or not-fixed item: exact repro, the
   observed-vs-expected, root cause with `file:line` where known, and a suggested
   fix. Reproduce before asserting; distinguish a real defect from a
   daemon-session/environment artifact.
3. **Comment the verification result** on each closed issue / merged PR you
   confirmed (fixed / not-fixed / blocked, with the evidence).
4. Summarize: what's genuinely done, what regressed, what's still blocked and why,
   and any release-checklist items (e.g. re-cut the ctrlproxy APK / iOS runner so a
   runner-gated feature reaches users; version bump).

## Output discipline

`observe` returns ~50KB. Never paste hierarchies — extract only the field that
proves the point (element counts, a specific value, a diff mode, ground-truth from
adb/simctl). When delegating a sweep to a subagent, require the same discipline and
a compact PASS/FAIL table back.
