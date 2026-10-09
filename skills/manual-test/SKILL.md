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
     (`isRunning()`, `src/ctrlProxy/IOSCtrlProxyManager.ts:988-995`, and the
     `attemptedSetup` reuse at `:966` which also re-probes via `isAvailable()`);
     cached artifacts alone never short-circuit.
     - **Service already running / responsive** — the builder is never consulted, so
       the override is **bypassed with no diagnostic** and you attribute results to a
       local build that never ran.
     - **Anything else, including cached-but-not-running** — setup reaches
       `needsRebuild()` (`src/ctrlProxy/IOSCtrlProxyManager.ts:1001`), which returns true
       whenever an override is set (`src/ctrlProxy/IosCtrlProxyBuilder.ts:393-396`).
       `build()` then calls `ensureBundleDownloaded()`, which throws
       `CtrlProxy bundle override is not a file`
       (`src/ctrlProxy/IosCtrlProxyBuilder.ts:741-742`); that becomes a failed build
       result (`:485-495`) and `setup()` returns the failure
       (`src/ctrlProxy/IOSCtrlProxyManager.ts:1020-1028`). There is **no** fallback to
       cached artifacts — CtrlProxy iOS **setup fails loudly**.

     So: if iOS setup fails with `bundle override is not a file`, unset the override;
     if it appears to work, a runner was already live — confirm which runner actually
     served the call (ref
     [#4221](https://github.com/kaeawc/auto-mobile/issues/4221)). The build script
     writes to the **default** derived-data path (`/tmp/automobile-ctrl-proxy`), so
     no path env var is needed; only for a non-default location set
     `AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA=<derived-data-root>` (the root — the
     code appends `Build/Products` itself).

   - **Serve a locally built iOS runner.** Set
     `AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD=true` and point
     `AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA=<derived-data-root>` at your build
     (omit the path variable for the default location). Local-build mode never
     downloads or extracts the released bundle, regardless of cache metadata,
     `AUTOMOBILE_VERSION`, or a vendored bundle override. It validates the local
     products before consulting release metadata, including during background
     prefetch. **Do not set `AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD` or pass
     `--skip-ctrl-proxy-download` for this workflow:** the skip flag returns earlier
     and bypasses product validation, pin capture, and prefetch.

     The daemon derives the expected SHA from your freshly built runner, pins it
     per platform, and re-verifies it before launch (a hash change with unchanged
     binary identity still fails closed) — no SHA to hand-copy. Rebuilding is
     picked up on the next launch without a daemon restart: the pin is re-derived
     when the binary's size or mtime changes, with an INFO log showing the old and
     new short SHA. It logs a loud WARN that the release-pinned guard is relaxed
     for the run. Missing or invalid local products fail with an actionable error
     naming the expected derived-data/products path and the platform-specific
     rebuild command. For simulators, use
     `AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA=<derived-data-root> bash scripts/ios/ctrl-proxy-build-for-testing.sh`;
     physical devices require a device build with valid signing and provisioning.
     Background prefetch records this error without crashing the daemon.

     To enforce your own SHA, also set
     `AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256=<64-hex>` (and
     `AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256_TARGET=runner|xctest` to pick the
     binary; defaults to the release's target). An explicit value overrides
     local-build mode for hash verification only; it never enables a release
     download in local-build mode. Unset it if you want auto-derivation.

     **Non-local-build note:** `AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD=true` (or
     `--skip-ctrl-proxy-download`) suppresses release downloads and prefetch, but
     retains release-pinned runner verification. It is not the local-build setup.
     **Caveat — it is process-wide, not iOS-only:** it also suppresses the Android
     CtrlProxy download/install, so install the freshly built APK on the emulator
     yourself (`adb install -r <fresh apk>`) before starting the daemon, or run the
     Android leg in a separate daemon without the flag.

     If the daemon reuses a runner it did not launch, it logs a loud WARN
     (`Reusing an external CtrlProxy runner this daemon did not launch`) — treat
     that as a signal to confirm which runner served the call.

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
  sendKeys, pressButton, dragAndDrop, pinchOn, rotate, launch/terminate,
  device state, navigation) and confirm well-formed output on the fresh runners.

**Overlay (`prototype`) acceptance:** when the range touches the overlay host, tool or
`layer` scoping, run the recipe in [overlay-acceptance.md](overlay-acceptance.md).

**Device-session idle release:** when the range touches session liveness, run
`bash scripts/live-idle-release-check.sh --confirm-live --serial <emulator> --port <unused-port>`
against an emulator no other daemon holds. It starts its own private daemon with a
20 s idle window and checks, per scenario: `active` (held while the proxy
heartbeats and calls tools), `no-heartbeat` (released about 10 s after heartbeats
stop), `idle` (released once the window passes with heartbeats only), `stdin-eof`
(the proxy exits when its stdin closes and the device is released within the same
budget), `selector` (calls naming only `deviceId` are credited to the holding
session), `stream` (an observation-stream subscriber stays subscribed across the
release and sees no `device_session_ended`), and, with `--second-serial <emulator>`,
`two-devices` (A goes at its own idle deadline while B, in use, stays held).
`--scenario provision` repeats `selector` for a `provisionDevice`-minted session
(opt-in: the tool is not enabled everywhere). Evidence (`--daemon active-sessions`
snapshots, daemon log lines, stream frames) lands under
`scratch/live-idle-release-check/`. To see who holds a device on any daemon, run
`--daemon active-sessions`. The same single-emulator scenarios run on demand in CI
from the `Live Idle Release` workflow
(`.github/workflows/live-idle-release.yml`, dispatch plus an advisory nightly run); it never runs
on pull requests.

**Desktop / IDE idle-release checklist (manual; run with the desktop app against a
private daemon with a short `AUTOMOBILE_SESSION_IDLE_TIMEOUT_MS`):**

1. Watching a device (mirror open, no input) never allocates it: `--daemon
   active-sessions` shows no session for that serial.
2. The first tap allocates it: a session with `holderKind` for the desktop appears
   and the tap lands.
3. Further taps refresh the idle window: `lastToolActivityAt` advances, and the
   session outlives one idle window while you keep tapping.
4. Stop interacting: the session is released at the idle deadline and the pane
   drops back to watching (no session listed, device still alive in `adb`).
5. Hide or minimize the window (or switch away from the device pane): the device is
   released promptly, within the no-heartbeat budget, not after the idle window.
6. IDE snapshot/record (#10831): starting a snapshot or recording from the IDE
   allocates like a tap, and finishing it lets the idle window run out normally.
   While an agent holds the device, the IDE is refused rather than taking it over.

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
