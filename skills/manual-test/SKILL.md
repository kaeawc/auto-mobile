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

Several roles may each drive their OWN device in parallel, with one actor per
device; never let two actors drive the same device. Every role takes
`boot-gate` before acquiring a broker session so boots are staggered and
wait for host load to settle; wrap broker proxy `up` to hold the permit through
bring-up. Run `preflight` before the batch: keep AC power attached, the lid open
(or an external display connected), and idle sleep held using the printed
caffeinate line. Caffeinate cannot prevent clamshell sleep on battery. Treat
timings measured across a host sleep or a load spike as invalid.

## Harness

Use [the manual-test harness](../../docs/using/manual-test-harness.md) for private
batches: `private-daemon.ts init|start|status|stop|env|wrappers|devices|shutdown-devices|preflight|boot-gate`, `in-daemon-env.sh`,
`proxy-session.ts up|serve|call|read|tools|resources|subscribe|status|close|release|abandon|info|owner-kill`,
`broker-batch.ts up|status|down|report`, `broker-scenario.ts list|run`,
`daemon-frame.ts send|session-info|heartbeat`, and `aux-socket.ts recording|video|webrtc` under
`scripts/manual-test/`. Use those commands instead of hand-rolling a private
environment, MCP stdio loop or socket client. For Python/anyio close and typing
reproduction, use the [Python MCP SDK stdio clients](../../docs/using/manual-test-harness.md#python-mcp-sdk-stdio-clients).

Initialize with `private-daemon.ts init --broker-batch /absolute/broker-batch.json
--count 1` and use one broker daemon per batch. `--max-devices` defaults to 2,
hard cap 4. Use `idlePoolCap: 0` and `reuseCleanDevices: false`; reserve
`--allow-reuse` for a deliberate clean-reuse scenario (none is currently named
in the runner; device scenarios/acceptance require zero pooling).
`broker/host-config.json` holds rendered operator defaults/limits;
`broker/clients.json` resolves clients to `sessions/<client>/` request/token and
evidence files; `evidence/ledger.jsonl` binds grants to native devices and cleanup.
The harness owns `AUTOMOBILE_SESSION_BROKER_CONFIG`/`AUTOMOBILE_SESSION_CONFIG`:
inherited values are scrubbed, `--env`/`--daemon-env` overrides refuse, and only
daemon 1 start receives the operator config. Client requests use `--client`.
See the [broker contract](../../docs/design-docs/session-broker-experiment.md)
and [requirements](../../docs/design-docs/session-requirements.md).

Use `broker1 up` to run strict preflight, probe `session-broker/v1`, and gate
acquisitions by host load and boot permits; it finishes planned ready clients
before capacity-refusal clients. `--clients a,b` or `--all`, `--stagger-ms N`
(default 0), and `--max-devices N` are `up` options. `status` reports all clients;
`down` closes them in reverse start order and verifies released receipts plus
native absence (240 s); info-less grants with settled release receipts instead
record `released` with `absence: not-verifiable`, allowing subsequent runs without
claiming absence. `up` captures info best-effort with a 5-second bound. `report`
writes `evidence/broker-report.json`.

Use `proxy1 up --client NAME` for a fresh attempt, `--resume` for identical
request/token replay, and `--expect ready` or `--expect failed:<code>` for an
expected outcome (exit 0; mismatch 2). Gate individual `up` commands too.
`--profile` takes an archetype or inline device requirement; `--request` takes
SessionConfig JSON/path; both are `up`/`serve` options and mutually exclusive.
`--owner disposable` records an owned sleep PID/start identity; `owner-kill
--client NAME` signals only that identity-confirmed owner. Use `info`, `release`,
`abandon`, `close` and `status --client NAME` for lifecycle evidence;
`status --all` lists the batch. Release polls cleanup; abandonment returns a
bounded receipt that may still be cleanup-pending, so verify status/absence. `release`/`abandon --as-client OTHER` deliberately
use another batch client's stored token for isolation tests.
`call --allow-foreign-session OTHER` permits explicit selectors for that ready batch
client for product-refusal testing. Neither option authorizes device takeover.

Run `broker-scenario.ts list` for fake/device classes and
`run NAME --batch-dir B [--device] [--max-devices N] [--dry-run]` for a selected
scenario. Fake entries use an in-memory broker/native fake without devices or
daemons. Device entries require an already-running private single-daemon batch,
zero pooling, strict preflight, no live client drivers, and verified prior cleanup.
Only `daemon-restart-with-live-sessions --device` accepts `--crash`.
The [scenario/evidence table](../../docs/using/manual-test-harness.md#broker-scenarios-and-acceptance)
lists expected assertions. Summaries at `evidence/<scenario>/summary.json`
include redacted requests, timings and ledger deltas. Destruction/handoff
resource samples are `not-verifiable` until a product read-only diagnostic exists;
inventory/receipt checks do not prove internal resource transitions.
`live-device-acceptance.ts --scenario broker --broker-batch B` reuses those device
scenarios; live execution also requires `AUTOMOBILE_ACCEPTANCE_LIVE=1`,
`--confirm-live` and `--test-owned-devices`. It accepts `--clients`, `--only`,
`--max-devices`, `--allow-crash` and `--dry-run`; no `--platform` in this lane.

- Never touch the resident daemon, its default socket, port 3000 or
  `~/.auto-mobile`; every client uses the wrapper or a guarded harness CLI.
- Never `pkill`/`killall`; stop only your own daemon with `private-daemon.ts stop`.
- Protect non-batch devices at `init --protect NAME_OR_ID` (repeatable).
- Broker teardown: `broker1 down`, `broker1 report`, then stop the private daemon
  and the batch's caffeinate by its recorded PID. Save device evidence first.
  No device process signals, `force`, `adb emu kill`, or manual AVD/simulator deletion.
  Zero-pooling release destroys the device through product cleanup; verify it.
- Broker batches never make sessionless device calls or generic lifecycle calls
  (`startDevice`, `provisionDevice`, `getAndroid`, `getApple`, `killDevice`).
  Calls require a ready grant and live driver; inventory resources and
  `--allow-selector` are refused. Pending/failed acquisition cannot fall back.
- For separate plain batches, `shutdown-devices` only stops proven unprotected
  batch devices. Check inferred devices, then select exact serial/UDID with
  `--device`; ambiguity refuses. Plain acquisition requires `avdName` or
  `deviceId`; `--allow-selector` is only for deliberate selection tests.
- Device lock: one actor per granted device; private coordination/registry and
  the broker host lock remain batch-owned. Report unaccounted inventory/startup
  refusals rather than removing other devices to make the broker start.
- Run `private-daemon.ts start` before proxy `up`/`serve`; both require a
  private PID file naming a live daemon AND a responding control socket
  (`daemon/capabilities`); a recycled PID is not enough. Proxy `status` reports
  `daemonSocketAlive`. Never use a proxy to wake a dead daemon.
- Never pass daemon flags to a proxy or rebuild `dist/` while batch daemons run.
- Keep one shared adb-server coordination directory per batch; split it only
  when testing isolated registries, aware of the false 7-of-6 finding (#11905).

The harness path registry (`scripts/manual-test/productPathEnv.ts`) uses this policy:

| Kind     | Destinations                                                                                                                              | Handling                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `state`  | Data, logs, DB directory, coordination, shared ADB registry, aux/control sockets, PID/lock/launch log, iOS cache and derived data         | Required isolated defaults. Defaults relocate state without enabling a feature.                                                         |
| `opt-in` | `AUTOMOBILE_IOS_CTRLPROXY_RECORD_DIR`, `AUTOMOBILE_PLAN_HEALTH_DIR`, `AUTOMOBILE_TOOL_OUTPUTS_DIR`, `AUTOMOBILE_STARTUP_BENCHMARK_OUTPUT` | Unset by default; both inherited spellings stripped. Explicit private absolute paths through `--env`/`--daemon-env` enable the feature. |
| `unset`  | `AUTOMOBILE_DB_PATH`, `AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH`                                                                              | Strip competing overrides in both spellings.                                                                                            |
| `input`  | APK/IPA/bundle, codec/encoder/helper, project/migration/signing inputs, test markers and config sources                                   | Caller-selected inputs, no harness defaults; broker/session config is harness-owned and stripped from inherited env.                    |

The linked harness guide lists every variable. `env.sh` unsets absent opt-ins;
client gates validate them only when present. Before product imports, entry
scripts preserve explicit stderr sinks and permit file logging only with an
explicit absolute log directory outside both home defaults (lexical and
ancestor-realpath checks). They force stderr otherwise, including invalid sinks
and data-dir-only environments, and restore all overrides in child environments. Known uncovered product path:
`~/.auto-mobile/libwebp` has no override
(`src/utils/image/webp/WebpBinaryResolver.ts:94`). A private daemon needing a
libwebp download would write there; set `AUTOMOBILE_CWEBP_PATH` and
`AUTOMOBILE_DWEBP_PATH` to avoid it.

`init --env K=V` applies to the batch; `--daemon-env N:K=V` overrides it for
one daemon. Record argv tokens with `--daemon-arg`, for example
`--daemon-arg --plan-execution-lock-scope --daemon-arg session --daemon-arg
--tool-call-recording`; `N:token` selects a daemon. Restarts reuse these env/args.
`start -- …` adds one-off argv. Use generated `<batch>/bin/amN|proxyN|frameN|auxN|brokerN`
wrappers; `amN cli …` runs the one-shot CLI with `--cli`. It finds the private
daemon through the socket and PID path env sourced from `env.sh`.
`in-daemon-env.sh --cd` is an explicit cwd change; its `cli` shorthand matches `amN cli`.

`pid.txt` is mirrored after successful start and removed after successful stop.
`status` reports PID agreement/socket state; `status --devices` also returns
host inventories and `daemonDevicesMethod: "daemon/availableDevices"`. It is
read-only except for the daemon's own inventory ownership/discovery refresh.
Android inventory reads the local ADB server socket without launching `adb`,
so it can neither start nor restart a server.
`wrappers` regenerates wrappers alone. Control sockets are at the short aux
root (`/tmp/am-mt-<hash>/<N>/d.sock`), not under the batch directory. Redirect
stdin with `< /dev/null` on harness calls made through an agent tool call.

`frame session-info SESSION` uses `daemon/sessionInfo`; `frame heartbeat SESSION`
uses the external CLI keeper, without claiming liveness ownership. The daemon
rejects a heartbeat for a proxy-owned session and changes nothing. Destroy modes
`cancel`/`cancel-after` retain their semantics. `--mode cancel-keep-open[:<ms>]`
(default read window 5000 ms) waits `--cancel-after-ms` (default 0), sends a real
same-connection cancel frame, prints late answers and an answered/unanswered
summary, then ends gracefully. Repeatable `--then '<method> <json|@file>'` sends
sequentially after the first answers in send mode. Params string placeholders
`{{ownSessionId}}`, `{{clientSessionId:<name>}}` and
`{{ownLivenessOwnerToken}}` use `--broker-binding <client-or-request.json>`;
unresolved values refuse before connecting. Client bindings keep existing ready
grants on exit; standalone request bindings acquire/heartbeat/release on this
connection and can boot a device. Standalone request paths are refused inside
broker batches; use `--broker-binding <client>`. Gate any standalone acquisition.
`--token-of OTHER` changes only status/release isolation frames to that batch
client's stored token. `--expect-refused` (send only) requires errors with product
refusal codes/messages. Lifecycle probes permit only `{}` or only the client's
own `sessionUuid`; any device name or selector refuses before sending. Inventory
resources and `--allow-selector` remain refused. Every frame uses host-mutation
guards; owner tokens are redacted.

Recording requires a **device session**, never an observer: owner for start/stop,
any live device session for status; a retained stop result permits the former
owner's UUID. Obtain `sessionUuid` from `init.json.session` printed by proxy up/status or the tool
response, or `amN daemon active-sessions --json`. Correct example:
`<batch>/bin/aux1 recording status --session-uuid SESSION < /dev/null`.
`--observer` remains available for video/WebRTC only. Current recording names
are `recordToolCalls`, `recordDeviceGestures`, `--tool-call-recording` and
`device-gesture-recording.sock`.

Client help (`--help`, `-h`, `help`, `<subcommand> --help`) exits 0 on stdout;
parse errors exit 2 with a help pointer. Frame/aux codes: 0 success/cancel ran,
1 typed refusal, 2 usage/guard, 3 timeout/connection. Proxy codes: 0 success/status,
1 failed response, 2 usage/guard/wait deadline, 3 serve transport closed,
4 serve initialization failed. Private-daemon codes: 0 success/status;
1 typed non-success outcome (daemon still alive, a device not stopped, inventory errors,
`preflight --strict` with warnings); 2 usage/guard/I/O or a `boot-gate` wait
deadline. `start` still propagates the product launch command's exit code.
`boot-gate -- COMMAND` exits with the command's code.

### Devices and teardown

The daemon launches with `MT_BATCH=<batchDir>` and `MT_DAEMON=P<index>`; its
emulator inherits that environment. Positive evidence reads it with `ps eww`
for the one console-port listener PID `lsof` resolved. It has not yet been
observed on a live batch. `bootedBy: "daemon<N>"` comes from `MT_DAEMON`;
`processAvdName` is the emulator's `-avd` argument. These optional fields appear
in device snapshots; `seenByDaemons` only records visibility.

Provenance: `batch-booted` has this batch's exact process marker; `foreign` has
read process environment without it, overriding baseline inference;
`preexisting` has no process evidence and its ID in the first-start baseline;
`batch-inferred` has no process evidence and its ID absent from a recorded
platform baseline; `unknown` has missing/unavailable baseline without process
evidence, or conflicting daemon rows. Every iOS simulator lacks process
evidence. Default teardown targets only positive, unprotected virtual devices;
check and select inferred devices by exact device ID (serial/UDID) with `--device`.
A unique name may select a `batch-booted` device. An ambiguous selector stops
nothing (`ambiguous` for each match); a separate unambiguous selector still applies.
Foreign, preexisting, unknown and physical devices are refused even when named.

Protection matches `deviceId`, `name`, `identity.stableId` and `processAvdName`.
Empty/`Unknown (<serial>)` Android names without a process AVD name are refused
when the protected list is nonempty. Another daemon's hold blocks frames;
any other `heldBy` string is tolerated as held and refused locally as
`broker-held`. Use broker release, never shutdown, for a held grant. The harness
never signals device processes or passes `force`. Baseline recording failure warns once with
`BASELINE WARNING:`; it never changes `start`'s launch result.

| Outcome                | Meaning                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `stopped`              | Shutdown succeeded or `device_already_stopped`; retain the daemon's message.            |
| `refused`              | Product refusal with code/message.                                                      |
| `failed` / `timeout`   | Request failure/deadline; no mutation retry.                                            |
| `protected`            | Protection matches or name evidence is insufficient.                                    |
| `not-batch-booted`     | Physical, foreign, preexisting, or unknown; never sent.                                 |
| `inferred-not-stopped` | Check the inferred device and name it by exact device ID (serial/UDID) with `--device`. |
| `broker-held`          | Held device refused locally; use broker release.                                        |
| `held-by-other-daemon` | Another daemon holds it; never sent.                                                    |
| `ambiguous`            | Multiple matches; this selector stops nothing. Name targets by device ID (serial/UDID). |
| `not-found`            | Explicit selector missing from the view.                                                |
| `dry-run`              | Eligible target, no shutdown frame.                                                     |
| `daemon-dead`          | Snapshot evidence only, no shutdown frame.                                              |

Every result includes `provenance` and `bootedBy` when known. Selected daemon
inventory refusals, unparseable replies or transport failures add top-level
`daemonErrors: [{name,error}]` and make shutdown exit 1; healthy targets are still
processed. A socket reply is `alive: true` even when unparseable. `devices`
exits 1 only when no daemon produced an inventory. Without inventories, fallback
reports unprotected batch-booted/batch-inferred snapshot devices, honors
selectors including ambiguity, retains explicit refusal rows, and sends nothing.
Otherwise shutdown exits 0 only if all results are stopped/dry-run and there are
no inventory errors.

Broker views also classify `allowed`/`foreign`/`protected` using the ready grant
and native descriptor in `evidence/ledger.jsonl`; protected wins. `devices --ledger`
reads evidence without probes. `amslot-*` is recognized through the product
`isSessionBrokerDeviceName` predicate, never hardcoded in the harness. A name
alone never permits access; the matching batch ledger binding is required.

`stop --crash` is only for explicit private crash recovery: SIGKILL the recorded
daemon PID after socket/PID-file and recorded process start identity checks,
never children/groups or a guessed PID. It refuses missing/mismatched identity
and never delegates to the product stop CLI. Ordinary stop remains bounded SIGTERM.

`stop --wait-ms 0` signals and reports `still-alive` unless the daemon is already
gone. `boot-gate --min-interval-ms` is best-effort with more than one concurrent
permit. A killed gate leaves its `permit-N.lock` until its PID is gone. Grant
JSON uses `permit`; wait JSON uses `waitingFor: permit` (or `load`/`interval`).

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

1. **Sync git.** Prepare an isolated checkout at the intended main revision.
   The private daemon and proxy must use that checkout's explicit
   `dist/src/index.js` entry script on the same commit. Do not change the
   resident daemon's checkout or rebuild a running batch's dist.
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

1. Initialize a new private batch with `private-daemon.ts init --batch-dir B
   --count 1 --base-port <unused-port> --server <absolute-dist-entry>
   --broker-batch <absolute-broker-batch.json> --max-devices 2`.
   If replacing a daemon you started, use `private-daemon.ts stop --batch-dir B
   --daemon 1`, then `start`. Never stop another batch's or the resident daemon.
2. Start ONE private daemon using `private-daemon.ts start --batch-dir B --
   <daemon-flags>`. Set run environment options with repeatable `init --env K=V`:
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
     served the call (#4221). The build script
     writes to the **default** derived-data path (`/tmp/automobile-ctrl-proxy`), so
     no path env var is needed; only for a non-default location set
     `AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA=<derived-data-root>` (the root — the
     code appends `Build/Products` itself). The private harness defaults this path
     under the batch, so explicitly point it at your prebuilt tree.

   - **Serve a locally built iOS runner.** Set
     `AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD=true` and point
     `AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA=<derived-data-root>` at your build
     (the private harness defaults to its own tree, so explicitly select your build). Local-build mode never
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
     in-app `highlight` (registration is **daemon-side**; configure the private
     daemon before starting proxy sessions).
   - `--network-mockable` — required for `mockNetwork` / network error-simulation.
   - To test the **gated-OFF** assertion (criticalSection/executePlan hidden
     without debug), start WITHOUT `--debug`/`--embedded-sdk`.
3. Check `private-daemon.ts status --batch-dir B`, then use
   `in-daemon-env.sh --batch-dir B --daemon 1 daemon status` for readiness.
   Confirm the manifest port/socket and your private launch log before testing.

During the restart-handoff scenario, keep the original proxy alive and verify
its same-session reconnect. Outside that scenario, close the prior execution,
verify cleanup, then use `proxy1 up --client NAME` through the boot gate for a
fresh attempt. Use `--resume` only for deliberate identical-request replay;
retain unchanged request/token bytes. Drive calls through
`proxy1 call --client NAME`; never set an active device or acquire generically.
Never pass daemon flags to the proxy; a build/option mismatch must be resolved in your private
batch before continuing. Do not replace the resident daemon to fix a mismatch.

## Phase 3 — Exercise tool calls (Android, then iOS)

Use the target client's granted session and leave other clients alone. For **each** checklist item:

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

**Prototype acceptance:** when the range touches the prototype host, tool or
`layer` scoping, run the recipe in [prototype-acceptance.md](prototype-acceptance.md).

**Broker execution oracle (historical owner-liveness check #11340):** an
execution remains held past its declared idle timeout while the execution owner
and proxy heartbeat remain alive; reads/heartbeats do not count as tool activity.
Test explicit release, owner loss and abandonment through the broker scenarios.
Require the stored terminal request receipt with cleanup complete and native
absence under zero pooling. A fresh attempt gets a fresh execution UUID;
terminal identity replay cannot acquire again. Restart handoff and PID fencing
have separate scenarios; retain their `not-verifiable` resource-state limits.
The plain-session idle oracle below belongs in a separate non-broker batch.

**Plain device-session idle release:** when the range touches session liveness, run
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

**Plain-mode device-ownership read oracle (owner decision 2026-10-12, #11964):**

A read never writes settings on a device it does not hold, with one exception: readiness needed to answer the read.
A sessionless read that names a running device nobody holds may ready it in order to answer: on Android it may
install the CtrlProxy APK, write the accessibility settings, and force-stop and rebind the service; on an iOS
simulator it may install and launch the runner. The exception never applies to a device held, broker-assigned or
reserved by another session: those reads use what is already installed and never run readiness.

A sessionless read installing/enabling CtrlProxy or launching the iOS runner on an
unheld running device is expected. Any readiness manager operation or ADB write
on a held, broker-assigned or reserved device is a defect. See
[the per-tool readiness table](../../docs/using/device-ownership.md#which-read-tools-ready-an-unheld-device).

**Plain-mode Desktop / IDE idle-release checklist (manual; run with the desktop app against a
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
