# Session broker device reuse, reset, and capacity

How to trade device startup time against reset work and host capacity. Covers the
reuse modes delivered under #14358: iOS erase and keep-booted, Android snapshot and
keep-booted, reset-boot admission, and the per-session mutation journal. None has
passed real-device contamination qualification, and no matched timing comparison
shows reuse beats creating a fresh device.

## Current status

The broker is opt-in via `AUTOMOBILE_SESSION_BROKER_CONFIG`; every reuse mode
defaults off.

- **iOS**: `reuse.ios.mode` is `off`, `erase`, `keep-booted`, or `minimal`. Legacy
  `reuseCleanDevices: true` still selects `erase` and cannot combine with a
  `reuse.ios` block choosing another mode. See
  [iOS minimal mode](#ios-minimal-mode) for `minimal`.
- **Android**: `reuseAndroidCleanDevices: true` plus `androidResetMode`
  (`snapshot` or `keep-booted`). The flag without a mode gives no reuse (release
  cannot prove unobservable state was restored, so the device is destroyed). iOS
  settings never enable Android reuse.
- **Admission**: iOS reset boots hold their boot slot across stop, erase and boot;
  `limits.maxConcurrentResetBoots` can queue them; an iOS request can wait for a
  compatible device about to finish resetting.
- **Journal**: journaled tools record the mutation before acting; a recording
  failure warns and the tool proceeds. It guides best-effort reverts and is not an
  admission gate.

Keep-booted is best-effort cleanup, not a guarantee that all state was reset. Known
degradation until #14786: iOS keep-booted reset on iOS 27 always falls back to
erase (the absent-key `defaults delete` wording is not recognized), so the measured
~10 s keep-booted reuse is not yet reachable there.

## Choose an iOS reuse mode

| Mode               | What it does                                                                                                                    | Boundary                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `off`              | Destroys the device on release; next request creates one                                                                        | No idle device retained                                                   |
| `erase`            | Stops, erases, then boots the same device before reuse                                                                          | Erase and boot checks must succeed, else destroyed/unavailable            |
| `keep-booted`      | Runs platform cleaning, then a health check, leaving the device booted                                                          | Not a claim all state was cleaned (see "What keep-booted does not clean") |
| `minimal` (#14682) | Keeps the device booted; uninstalls session apps, resets keychain and privacy, restores appearance, content size and pasteboard | No erase fallback; no baseline diff (see "iOS minimal mode")              |

In `keep-booted`, `maxUses` (default 10; 20 in `erase` mode, where it has no effect) forces every Nth release to erase instead;
on success the same device returns to idle and later releases can use keep-booted
again. It bounds drift rather than capping sessions or retiring the device.
The only iOS fallback is `erase`.

```json
{
  "reuse": { "ios": { "mode": "keep-booted", "maxUses": 10, "fallback": "erase" } },
  "limits": {
    "idlePoolCap": 2,
    "totalDeviceCap": 10,
    "sessionCap": 6,
    "maxConcurrentResetBoots": 2
  }
}
```

A fragment: include `contractVersion` and `defaults.ios` from
[the broker experiment](session-broker-experiment.md); any mode other than `off`
requires `defaults.ios`. `iosClassifications` is optional (default `[]`). The
schema rejects `reuseCleanDevices: true` alongside a `reuse.ios` block that does
not select `erase`.

### iOS minimal mode

`reuse.ios.mode: "minimal"` (#14682) keeps the simulator booted and runs only these
steps on release, in order, each with its own time budget (`AUTOMOBILE_IOS_RESET_STEP_BUDGET_MS`):

1. terminate and uninstall each app the session installed (from the mutation journal), and uninstall
   the managed Files fixture app when the session staged `user_files` files,
2. `simctl keychain reset`,
3. `simctl privacy reset all`,
4. `simctl ui appearance light` and `content_size large` (the defaults a broker-created
   simulator enters the pool with),
5. empty the pasteboard.

It runs no baseline diff and no health probe, and it never falls back to erase or a
reboot. Any failed or timed-out step, an incomplete mutation recording, or the
`maxUses`-th release (default 5; keep-booted uses 10) returns a `pending` reset
outcome, so the broker destroys the simulator and the next acquisition creates a
fresh one. A failure is recorded per session: a redrive repeats the destroy outcome
instead of cleaning a half-cleaned simulator again. Lost ownership still aborts the
release rather than destroying.

```json
{ "reuse": { "ios": { "mode": "minimal", "maxUses": 5 } } }
```

The only tunable is `maxUses`; `fallback` is rejected for this mode.

**Not reverted** (the trade-off for speed): locale, language and calendar, simulated
location, status-bar overrides, increase-contrast, reduce-motion and bold text,
notifications, contacts, calendar and photo stores, trusted certificates and
profiles, edits to preinstalled apps, app-group and shared-container contents of
apps the session did not install, and anything the journal did not record.
Choose `keep-booted` when those matter; choose `minimal` when sessions only install
and use their own apps and the cheaper release is worth the weaker isolation.
Device verification is pending (#14786, #14787 describe the keep-booted siblings of
the same simctl behaviours).

## Choose an Android reset mode

Separate opt-in, default off. `androidResetMode` requires
`reuseAndroidCleanDevices: true` and a `defaults.android` policy.

- `snapshot`: saves a named baseline snapshot for each freshly created or replaced
  emulator; release loads it, waits for readiness and checks health. On failure it
  relaunches the same AVD with wipe-data (keeping reserved boot capacity) and
  recaptures the baseline; otherwise the device is destroyed. `wipe-data` is the
  strategy's internal fallback, not a selectable mode. Broker snapshots are hidden
  from user snapshot tools; a session making opaque persistent changes (e.g. a user
  snapshot capture) still forces the wipe-data fallback.
- `keep-booted`: runs the cleaning operations below, then health. Every
  `androidKeepBootedMaxUses`-th (default 20) release goes to the fallback chosen by
  `androidKeepBootedFallback`: `"snapshot"` (which may itself fall back to
  wipe-data), or `"destroy"`/omitted (destroy on failed cleanup, failed health, or
  the `maxUses` limit).

`androidResetTimeoutMs` (default 600,000 ms) is valid only with `snapshot`, or
`keep-booted` plus `androidKeepBootedFallback: "snapshot"`, where it bounds that
fallback. `androidKeepBootedMaxUses` and `androidKeepBootedFallback` are rejected
outside `keep-booted`.

`androidIdleTtlMs` (optional, positive integer milliseconds; requires an
`androidResetMode`) destroys an Android device that has sat idle in the pool for that
long. Both modes keep the emulator booted while idle (several GB of RSS each), so it
applies to either. Omitted, an idle device stays booted until it is evicted or drained.

```json
{
  "reuseAndroidCleanDevices": true,
  "androidResetMode": "snapshot",
  "androidResetTimeoutMs": 600000,
  "limits": { "idlePoolCap": 1, "totalDeviceCap": 7, "sessionCap": 4 }
}
```

```json
{
  "reuseAndroidCleanDevices": true,
  "androidResetMode": "keep-booted",
  "androidKeepBootedMaxUses": 20,
  "androidKeepBootedFallback": "snapshot",
  "androidIdleTtlMs": 900000
}
```

Both need `contractVersion` and `defaults.android`. The strict host schema accepts
the iOS `reuse` block and the Android keys together.

## Admission and fallback order

Reuse is limited to an idle device compatible with the requested profile.

- **Reset wait (iOS only)**: a request may wait for a compatible resetting device
  only when the same profile has reset p90 and create/boot p50 samples from the last
  24 h. The device qualifies when its positive p90 remaining-time estimate is no
  greater than the shared cutoff (minimum create p50 + boot p50 across matching
  resetting candidates with usable estimates). The wait equals that estimate, capped
  by the preparation deadline; one waiter per resetting device; no matching samples
  means no wait. If the estimate timer fires first, normal admission resumes; if the
  deadline fires first, the request fails with retryable
  `session_preparation_failed`. It is a bounded opportunity, not a guarantee.
  Otherwise creation is subject to session, total-device and platform boot-gate
  limits; a cap never makes a busy or incompatible device reusable.
- **Reset boots**: an iOS erase reset reserves its boot slot before stopping and
  holds it through erase and boot. `limits.maxConcurrentResetBoots` queues excess
  iOS reset boots in the broker cleanup queue (not the boot gate); omitted shares the
  gate's host limit. Gate admissions are tagged `reset`/`create`/`restart` and
  `listDevices` reports live iOS admissions by reason.
- **Keep-booted release**: below `maxUses`, cleaning runs, then health; a passing
  health check returns the device to idle only while ownership is valid. Reaching
  `maxUses` skips cleaning straight to fallback (iOS erase; Android snapshot if
  configured, else destroy). On iOS, re-running a release that already recorded a
  failure also skips cleaning; a journal-load failure or unsettled earlier native
  step fails the release without the erase fallback (resource stays pending or is
  destroyed); failures during cleaning or health reach the erase fallback. Ownership
  loss prevents idle publication and cleanup/fallback stay ownership-fenced (pending
  or destroy, never a reset under a stale fence). `off` destroys on release.

## When a device is not reused

- **Owner exit** (`session_owner_exited`): the broker destroys the device after a
  delay (about 26 s in batch 20261021e) instead of resetting it to idle.
- **Graceful daemon restart**: active broker sessions are handed off and adopted
  (#12765, #13849) and keep their device. Android reset baselines live in daemon
  memory, so an adopted Android session's device cannot be reset on release and is
  destroyed; the next session needs a cold create.

## Keep-booted cleaning operations

No comparison of the result with the captured baseline; unsupported journal
reversions may be skipped (no all-kinds gate).

- **iOS**: replay supported journal reversions; remove non-baseline apps and their
  removable app-group containers; reset keychain and all privacy grants; clear
  location and status-bar overrides and pasteboard; restore
  appearance/content-size/contrast and locale-related global preferences; then check
  the simulator's booted target and automation health endpoint. The baseline guides
  selected operations only.
- **Android**: replay supported reversions; remove third-party packages absent from
  the baseline; revoke newly granted runtime permissions for retained third-party
  apps; restore settings; remove added files under supported shared-storage roots;
  clear clipboard if supported; then check boot completion, package-manager
  responsiveness and CtrlProxy health. Non-critical setting/revert errors are logged
  and skipped; critical cleaning or health failures use fallback or destruction.
- **Fallback**: iOS erase; Android snapshot reset (itself falling back to wipe-data)
  when configured, else destroy. Success makes the resource idle-eligible; failure
  leaves it unavailable or destroys it.

**Timings** (phase names are implementation details): iOS records journal,
preflight inventory, individual revert, sanitize (incl. `trust-store:verify`),
health and health-probe phases; native commands bound at 10 s, the health HTTP probe
at 5 s, reset steps default 30 s. Android keep-booted records journal, clean and health
phases. Cleaning uses the remaining `androidResetTimeoutMs` budget (default 600 s), or
one third of it when snapshot fallback is configured; fallback uses the remaining budget
minus a bounded 2 s command-settlement reserve. Android reset adb attempts derive their
timeouts from the remaining budget and retry transient timeouts with backoff; readback
mismatches still fail closed. Android snapshot phases include identity, load, readiness, health, stop and wipe-data launch. A
keep-booted fallback reports `fallback:snapshot` even if snapshot itself fell back
to wipe-data.

## What keep-booted does not clean

A successful run plus health check does not make the device equivalent to a freshly
erased or wiped one.

- **iOS**: Photos, Contacts and Calendar additions remain; baseline app data is not
  reset and baseline app-group data can persist in retained shared containers; other
  unsupported state may remain. A user-trusted root certificate is never left
  behind: `simctl keychain reset` does not clear the trust store, so the reset
  checks it and falls back to erase when any user trust setting exists (#14828).
- **Android**: accounts remain; baseline apps' data is not reset (no default
  `pm clear`); overwritten/deleted baseline files are not restored; added files are
  removed only under the supported roots; other uninventoried state may remain.

Use iOS `erase` or Android `snapshot` when a full reset boundary is required, and
`maxUses` to bound drift (iOS periodically erases and keeps the device; Android goes
to the snapshot fallback if configured, else destroys).

## Size caps independently

- `sessionCap`: active or acquiring sessions; size from peak simultaneous workload.
- `totalDeviceCap`: all broker-owned native devices (active, creating, idle,
  resetting, uncertain, still-destroying). Leave recovery headroom; pending
  destruction stays charged until absence is confirmed. One limit covers every
  kind: Android emulators of any form factor (phone, Wear OS, TV, Automotive),
  iPhone/iPad simulators (a CarPlay screen is a display of its iPhone, not a
  device) and Apple Watch simulators (`watchos` bindings and running
  `ambroker-` watches are charged; the broker cannot create a watch binding yet
  and refuses one as `spec_unsupported`).
- `idlePoolCap`: devices retained between sessions; more warm devices cost disk,
  memory and simulator/emulator capacity. Start small, from concurrent bursts and
  measured reuse demand.
- Platform boot-gate limit: concurrent boots (including creation/replacement under
  that gate); distinct from device-count caps. A watch boot takes a slot in the
  simulator (iOS) gate, which already counts every booted simulator.
- `limits.maxConcurrentResetBoots`: queues iOS erase resets and keep-booted's erase
  fallback; does not limit Android keep-booted cleanup; unlimited when omitted. Keep
  it at or below safe iOS boot concurrency.

Starting relationship: `totalDeviceCap >= sessionCap + idlePoolCap` plus allowance
for in-flight creation/cleanup (a target, not a promise: transitions and uncertain
cleanup also consume the cap). Reducing `idlePoolCap` does not evict immediately:
trimming runs when a device returns to idle. Separately, admission at the total cap
can evict the oldest idle device, matching or not. Active or resetting devices are
never evicted for an idle target. The `daemon/drainBrokerPool` operator method
destroys every idle pooled device through the same durable destroy journal, without
an acquisition; each device reports `destroyed` or `cleanup_pending`, and a replay
drains only what is still idle.

Idle expiry runs on the broker's recovery pass (every 5 s), so a device is destroyed
between the TTL and the TTL plus one pass after it went idle. The idle clock is held in
daemon memory per resource revision: reuse (which changes the revision) restarts it,
and a daemon restart restarts every clock from the first pass, so an idle device can
outlive one restart by up to one TTL. Expiry claims a device only while it is still idle
at the revision the pass observed, in a write transaction serialized with admission; a device
an acquisition reserved first, or one that is held, resetting or already destroying, is
never expired. Claimed devices are destroyed through the drain's destroy journal and
are joined on shutdown; iOS has no idle TTL.

### Worked sizing example

No matched comparison shows reuse reduces end-to-end latency; an idle-pool hit
moves boot work from acquisition to release. Illustrative (not measured) creation
p50 ~107 s, p90 ~124 s. Measured iOS erase reset: ~15 s stop, 0.3 s erase, 52 s
boot, ~67.3 s total. For up to six concurrent sessions retaining two warm devices:
`sessionCap: 6`, `idlePoolCap: 2`, `totalDeviceCap: 10` (if the host can hold ten
devices), and `maxConcurrentResetBoots: 2` or lower if the boot gate safely admits
two. At 67.3 s, two reset slots clear ten resets in ~5 waves (337 s), one slot in
~10 waves (673 s), ignoring queueing and variance. If observed reset p90 is well
above the estimate, adjust reset concurrency, `idlePoolCap`, or the client's
preparation timeout; more reset concurrency only helps with spare boot-gate and
host capacity.

## Read timing and stats

Acquire, release and status replies expose `timing`; correlate with
`daemon/sessionBrokerStats` (p50/p90). Tune in this order:

1. Compare create vs reset p50/p90 for the same platform and profile; if erase does
   not beat creation enough, use `off` or reduce idle retention.
2. Compare reset p90 with tolerable wait and the client's preparation timeout (there
   is no separate wait-duration setting; do not size from p50 alone).
3. Raise `idlePoolCap` only when compatible demand regularly exceeds retained supply
   and the host has spare capacity.
4. Compare concurrent reset demand with the boot gate and host pressure before
   raising `maxConcurrentResetBoots` (queued resets are inactive and cannot be
   waited on; a high wait p90 under saturated boot capacity is not fixed by the
   total cap alone).
5. Re-measure per strategy: iOS erase, iOS keep-booted, Android snapshot and Android
   keep-booted share no latency assumptions.

p50 is typical work; p90 is a conservative budget, not an upper bound. Use a recent
window with enough same-mode, same-profile requests; sparse or mixed samples hide
regressions.

## Ownership release hold

A managed session released while binding ownership is unconfirmed holds device teardown for up to 1.9 s on the daemon's timer. That is two shared turns at their worst case (700 ms attempt bound + the registry's 250 ms busy timeout each), covering the turn in flight when the hold is created and the hold's own expedited attempt. Creating the hold expedites one waiting re-own attempt, still in turn with other attempts; an in-flight attempt continues and recovery admission stays unchanged.

Confirmation starts teardown early. Proven ownership loss skips device writes. At the cap, teardown skips device writes and one warning reports that saved device state was dropped because ownership could not be confirmed. A `device_cleanup_in_progress` hint includes the remaining hold plus the bounded teardown time, resetting when the hold settles.
