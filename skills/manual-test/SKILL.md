---
name: manual-test
description: "Run one AutoMobile manual-test iteration: from a start point (commit, milestone/tag, or date), rebuild ALL components, restart the daemon with the right flags, and verify that closed issues and merged PRs actually fix their bugs / deliver their specced features on current HEAD by exercising tool calls on an Android emulator and iOS simulator. Defaults to a multi-device (2 Android + 2 iOS), multi-client method: several independent MCP stdio proxies against one private daemon; also covers device failure and repair, bug-vs-flaky-vs-environment triage, and performance measurement (timings, operation counts, payload sizes, device reset and reuse). Use when asked to retest landed work, verify a release, or manually test what changed."
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

Use [the manual-test harness](../../docs/design-docs/manual-test-harness.md) for private
batches: `private-daemon.ts init|start|status|stop|env|wrappers|devices|shutdown-devices|preflight|boot-gate`, `in-daemon-env.sh`,
`proxy-session.ts up|serve|call|read|tools|resources|subscribe|status|close|release|abandon|info|owner-kill`,
`broker-batch.ts up|status|down|report`, `broker-scenario.ts list|run`,
`daemon-frame.ts send|session-info|heartbeat`, and `aux-socket.ts recording|video|webrtc` under
`scripts/manual-test/`. Use those commands instead of hand-rolling a private
environment, MCP stdio loop or socket client. For Python/anyio close and typing
reproduction, use the [Python MCP SDK stdio clients](../../docs/design-docs/manual-test-harness.md#python-mcp-sdk-stdio-clients).

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
The [scenario/evidence table](../../docs/design-docs/manual-test-harness.md#broker-scenarios-and-acceptance)
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

## Default method: multi-device, multi-client

A full iteration runs **2 Android + 2 iOS devices at once** under ONE private
daemon, driven by **several independent MCP stdio proxies** — one proxy (own
process, own session) per device, plus one or two **contenders** that try to take
a held device, call sessionless, or read a device they do not own. Single-device,
single-actor runs are only a fallback for re-checking one item. Isolation,
admission, lifecycle, timeout and concurrency defects only show up this way, and
it is how the product is really used.

- **Pin the SHA.** `main` keeps moving (other lanes merge continuously). Resolve
  `origin/main` once, test that SHA for the whole batch, and record it with
  `campaign.sh verified --repo <owner/repo> --sha <sha>` (the script takes `--sha`,
  not a positional argument).
- **Prepare clean devices first** (wipe AVDs / erase sims you own), one at a time,
  Android first. Pin every AVD to an explicit non-5554 console port from its first
  boot (e.g. 5610, 5612) — a first boot can otherwise claim `emulator-5554`, the
  owner's port. If that happens, shut it down through the daemon's `killDevice` and
  relaunch on the explicit port. Use device names the broker does not count against
  its own budget: any running `ambroker-*` device is charged to the broker budget,
  so a broker batch and a plain batch cannot share those names.
- **Drivers** live under the batch directory, not the repo. Reuse
  `proxy-session.ts`, `scripts/mcp-drive.ts --plan`, `live-device-acceptance.ts`,
  `brokerDeviceScenarios.ts` and the multi-client coverage from the broker tests
  before writing anything new.
- **Harness traps learned the hard way:**
  - A daemon env change between restarts must be edited in BOTH
    `options.extraEnv` and `specs[0].env` of `batch.json`; editing one trips the
    tamper check.
  - After `proxy close`, bring the client back with a **new `--dir`**.
  - Sessions idle-expire (120 s default): touch every device inside that window
    (`pressButton` refreshes the idle window; `observe` and `setActiveDevice` do
    not). `AUTOMOBILE_SESSION_IDLE_TIMEOUT_MS` is read by the **proxy at start**, so
    restarting the daemon alone keeps the old window.
  - `--no-proxy` (direct mode) refuses to start while any other daemon is live, so
    direct-mode checks need a quiet machine or a separate run.
  - Redirect stdin with `< /dev/null` on harness calls made from an agent.
  - Subagents may be unable to write files; the coordinator writes `report.md`
    from the text they return.

### Multi-client scenario checklist

Run each on both platforms where it applies; record the observed field, not the
tool's `success`.

1. **Isolation:** client A never sees or steers B's device; a non-holder read of a
   held device is allowed (read oracle) but a pin/steer/mutation is refused.
2. **Contenders:** taking a held device, a sessionless call with several devices
   up (typed `ambiguous_device_target`), `capacity_exhausted` while the pool is
   full — each must be a **typed refusal in milliseconds, never a hang**.
3. **Pins:** `setActiveDevice` is per-connection and cleared on disconnect.
4. **Lifecycle:** release and immediate re-acquire by another client; daemon
   restart with live sessions rehydrates the same session ids; heartbeat loss
   releases within the idle bound; owner kill; takeover of an older daemon
   (deferral and its guidance); SIGTERM mid-call (call completes, daemon stops).
5. **Device loss:** `killDevice` (or killing your own emulator process) on one
   device while the others keep working; the disconnect monitor counts misses and
   releases without a restart storm.
6. **Stall injection:** SIGSTOP/SIGCONT the daemon PID **you started** for ~18 s
   with two emulators held — healthy devices must not be quarantined or reported
   `device_lost`.
7. **Timeouts and cancel:** per-tool budgets with the env var set client-only,
   daemon-only and both (the daemon decides); cancel mid-flight; release replies
   `cleanup_pending` and replays.
8. **Push streams:** 2+ telemetry subscribers incl. a slow one; frames carry the
   right `subscriptionId`; the slow subscriber is dropped without affecting others.
9. **MCP Tasks:** `startDevice` as a task from one client while another holds a
   different device.
10. **Tool sweep in parallel** on all four devices (observe, tap, swipe,
    setUIState, sendKeys, launch/terminate, install/uninstall, screenshot,
    systemTray, keyboard, pressButton), light/dark, cold boot vs quickboot.

## Device failure modes and repair

Know these before calling anything a product bug. Repair only devices you own
(`ambroker-*` / batch devices); never touch protected ones.

| Symptom                                                                        | Usual cause                                                                                | Repair / handling                                                                                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| New AVD comes up as `emulator-5554`                                            | Owner's port was free                                                                      | `killDevice` via the daemon, relaunch with an explicit console port                                                               |
| Sim goes `Shutdown` ~30 s after a daemon restart, daemon log shows no shutdown | External actor (another lane's simctl/launchd restart)                                     | Record as environment; re-boot via the daemon; do not file unless it reproduces with nobody else active                           |
| Emulator `offline` / `authorizing`                                             | adb transport still settling, or stale adb server                                          | Wait with a bound; `adb reconnect`; as a last resort restart the adb server only if no protected device depends on it             |
| Emulator process listed but no `sys.boot_completed`                            | Slow cold boot under load, or crashed qemu (SIGSEGV class)                                 | Check load first; relaunch with `-no-snapshot`; if it SIGSEGVs repeatedly under a GPU mode, change GPU mode (qualification issue) |
| Healthy emulators reported `device_lost` / quarantined during a daemon stall   | Probe timed out because the event loop stalled (fixed in #14347; regression if it returns) | Confirm with SIGSTOP/SIGCONT repro; compare against the probe-timeout log lines                                                   |
| Accessibility service never binds (API 35) / crashed a11y                      | Known platform behavior                                                                    | Reinstall the ctrlproxy APK, toggle the service, recover via the documented crashed-a11y path                                     |
| iOS observe empty right after a cold sim boot                                  | Hierarchy not ready                                                                        | Retry once; persistent empties are a bug                                                                                          |
| iOS runner stale / foreign runner serving the call                             | Reused external runner                                                                     | `grep 'Reusing an external CtrlProxy runner'`; restart the runner; confirm the served xctestrun path                              |
| Notification shade not closing on iOS 27                                       | Cover sheet, not Notification Center                                                       | Home press dismisses it (#14139)                                                                                                  |
| Keyguard / sleep-locked emulator                                               | `pressButton power` was used                                                               | Never power-press on Android; `wakeAndUnlock`                                                                                     |
| Daemon restarts replace your flagged daemon                                    | A competing daemon on the shared socket                                                    | Use a private daemon with isolated dirs and a non-3000 port                                                                       |
| Orphaned emulator/sim after a failed run                                       | Cleanup skipped                                                                            | Shut down only what your batch booted (`private-daemon.ts shutdown-devices`), then release the lock                               |

## Bug vs flaky state vs environment

Decide before filing. Work this list in order:

1. **Ground truth first.** Compare the tool's answer with `adb`/`simctl`/`dumpsys`.
   A tool result that contradicts ground truth is a bug candidate; a tool result
   that matches ground truth on a device in a strange state is not.
2. **Reproduce twice on a freshly reset device.** Deterministic (or ≥2 of 3) on a
   clean device = **BUG**. Passes after reset or never reproduces = **FLAKY
   STATE** — note it in the report, do not file.
3. **Check the host.** Load average above ~24 (or CPU contention from other lanes)
   invalidates absolute timings and explains most timeout misses. Re-run under
   quieter load or use before/after pairs under similar load.
4. **Check for external actors.** Device shutdowns or runner restarts that the
   daemon log does not show are **ENVIRONMENT** (another session, launchd, CI sim).
5. **Baseline against the previous build.** Build the previous verified SHA in a
   second worktree and run it as a second private daemon: if the old build behaves
   the same, it is not a regression (file as pre-existing only if it is wrong).
6. **Harness vs product.** Failures that vanish with a new `--dir`, a refreshed
   idle window, or the correct `batch.json` env are harness artifacts.

Classify every non-PASS item as **BUG** (file with repro, root cause, suggested
fix), **FLAKY-STATE** (record signature, no issue unless it recurs across
batches), **ENVIRONMENT** (record, no issue), or **HARNESS** (fix the driver).
Label policy: remove `needs-device-verify` only with direct evidence covering
**every platform the change touches**; partial evidence keeps the label and adds a
comment. A fix that merged but still fails on a device is **NOT-FIXED** — comment
on the issue and keep it open.

## Always measure: performance, speed, efficiency, fewer operations

Every batch is also a performance review. The goal is fewer operations, fewer
subprocesses, fewer round trips and less waiting — not just correctness.

- **Take a number for everything you exercise** and compare it with the previous
  batch's report (keep a running table in `report.md`). Use daemon-log timestamps
  (phase gaps) instead of wall-clock guesses; absolute times are contaminated by
  host load, so prefer before/after pairs and ratios.
- **Standard measurements:** acquire time (cold and reuse); "Starting emulator" →
  "Waiting for emulator" → ready; runner startup; `observe`/`tapOn`/`setUIState`
  latency; idle subprocess spawns per minute (`adb`/`simctl`/`devicectl`) and
  daemon CPU per 60 s; spawns per operation (e.g. simctl lists per boot/reset);
  failed probes per observe; payload sizes (`tool-definitions.json`, layout row
  bytes, observe size); push frame counts and subscriber fan-out; tool-list size.
- **Hunt for waste while you drive:** fixed sleeps that could be event-driven,
  polling that could be notified, serial work that could overlap, repeated reads
  of the same state, full inventories where a targeted read would do, redundant
  extractions after a tap, unbounded retries. File a performance issue with the
  measured numbers and the proposed saving; mark device-timing fixes
  `needs-device-verify`.
- **Device reset and reuse deserve a dedicated pass** (fast reuse is being built
  under epic #14358): time the erase/wipe baseline phase by phase (stop, erase,
  boot, ready, next acquire); verify cleanliness after reset (installed apps,
  permissions, settings, files, clipboard, keyboard, appearance, locale,
  rotation, notifications); run simultaneous resets on several devices; reset one
  device while another client drives a second; contend for a resetting device
  (typed refusal, no hang); interrupt a reset (daemon restart, kill) and check
  recovery; exercise any keep-booted or snapshot mode that exists at the pinned
  SHA and compare it with the erase/wipe baseline. Android quickboot keeps dirty
  state; only wipe-data is a clean baseline.
- **Report the table, not just the verdict:** metric | previous batch | this batch
  | delta | note on load. A faster path that is not clean, or a clean path that is
  slower than a cold acquire, is a finding.

## Phase 0 — Scope from the start point

1. **Get the start point.** Accept a commit SHA, a tag/milestone, or a date. If
   none was given, ask for one (offer the last release tag as default:
   `git tag | sort -V | tail`). Resolve it to a git ref `<START>`.
2. **Enumerate landed work** in `<START>..origin/main`:
   - Merged PRs: `gh pr list --state merged --search "merged:>=<DATE>" --json number,title,closingIssuesReferences` (or by commit range).
   - Closed issues: `gh issue list --state closed --search "closed:>=<DATE>" --json number,title,labels`.
   - Open issues awaiting device verification, with **no date filter**:
     `gh issue list --state open --label needs-device-verify --json number,title,labels`.
     These are implemented and merged but kept open until a device confirms them,
     so they never appear in the closed-issue query. Skip any also labelled
     `physical-device` unless this run has that hardware, and any labelled
     `epic` (verify its children instead).
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

## Phase 3 — Exercise tool calls (all devices; Android first, then iOS)

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

0. For a multi-client batch also write a **facet matrix** (facet × device × client)
   and the performance table from "Always measure"; classify every non-PASS item
   as BUG, FLAKY-STATE, ENVIRONMENT or HARNESS before filing anything.
1. Write a per-item table: `Item # | Type | Platform | FIXED / PASS / NOT-FIXED / REGRESSED / BLOCKED | Evidence (the field checked)`.
2. **File a GitHub issue** for every regression or not-fixed item: exact repro, the
   observed-vs-expected, root cause with `file:line` where known, and a suggested
   fix. Reproduce before asserting; distinguish a real defect from a
   daemon-session/environment artifact.
3. **Comment the verification result** on each closed issue / merged PR you
   confirmed (fixed / not-fixed / blocked, with the evidence).
4. **Settle every `needs-device-verify` issue you exercised.** On PASS/FIXED:
   comment the evidence (device, OS, build, the field checked), remove the
   `needs-device-verify` label and close the issue as completed. On
   NOT-FIXED/REGRESSED: keep it open, keep the label, and comment the evidence
   (file a separate issue only for a new defect). On BLOCKED: keep it open and
   comment what blocked it.
5. Summarize: what's genuinely done, what regressed, what's still blocked and why,
   and any release-checklist items (e.g. re-cut the ctrlproxy APK / iOS runner so a
   runner-gated feature reaches users; version bump).

## Output discipline

`observe` returns ~50KB. Never paste hierarchies — extract only the field that
proves the point (element counts, a specific value, a diff mode, ground-truth from
adb/simctl). When delegating a sweep to a subagent, require the same discipline and
a compact PASS/FAIL table back.
