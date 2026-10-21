# Session broker device reuse, reset, and capacity

This guide explains how to trade device startup time against reset work and
host capacity. It describes the session broker's current opt-in behavior plus
configuration proposed by the still-open reuse lanes under #14358. Treat the
mode-specific configuration below as a preview until its implementation PRs
have merged; do not assume a setting is accepted by the current daemon just
because it appears here. The reset-readiness admission wait and reset-boot
queue described below are also preview behavior from the open iOS cleaning
PRs, not current main behavior. The open implementation PRs do not claim
real-device or simulator qualification.

## Current status

The broker is opt-in through `AUTOMOBILE_SESSION_BROKER_CONFIG`. The current
main-branch host config has the legacy `reuseCleanDevices` boolean, which is
false by default. On iOS, setting it to true selects an erase reset: stop the
simulator, erase it, then boot the same simulator while holding the boot slot.
Main also has the `reuseAndroidCleanDevices` flag, but enabling it alone does
not provide Android reuse today: reset cannot prove restoration of
unobservable state, so release fails and the device is destroyed. Android reuse
is not enabled by the iOS `reuseCleanDevices` flag.

The newer per-platform mode and Android reset options described below are
still being delivered by open implementation PRs. Check those PRs for the
current implementation and integration status before enabling a preview
setting. The iOS reset-readiness wait and `maxConcurrentResetBoots` queue are
also only in the open iOS cleaning PRs. Keep-booted is best-effort cleanup,
not a guarantee that all device state has been reset.

## Choose an iOS reuse mode

The mode table describes only `reuse.ios.mode`; Android uses
`reuseAndroidCleanDevices` with `androidResetMode` instead.

| Mode          | What it does                                                                                 | Use it when                                                                  | Boundary                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `off`         | Destroys a device on release; the next request creates one.                                  | Isolation and simple lifecycle behavior matter more than warm-start latency. | No idle device is retained for reuse.                                                                       |
| `erase`       | Stops and erases the device, then boots the same device before reuse.                        | You want an explicit reset boundary and accept reset/boot latency.           | Erase and boot checks must succeed; otherwise the device is destroyed or remains unavailable.               |
| `keep-booted` | Runs its platform cleaning operations, then a health check, while leaving the device booted. | Lower reset latency is useful and residual state is acceptable.              | Successful cleanup is not a claim that all device state was cleaned; see “What keep-booted does not clean.” |

For iOS, the preview configuration replaces the coarse legacy switch with
`reuse.ios.mode`. In `keep-booted` mode, `maxUses` forces every Nth release to
use erase instead of keep-booted cleanup; its default is 20. This bounds
keep-booted reuse rather than capping sessions or retiring the device. When
that erase succeeds, the same device returns to the idle pool, and later
releases can use keep-booted again. `maxUses` has no effect in `erase` mode.
The iOS fallback is `erase`.

```json
{
  "reuse": {
    "ios": {
      "mode": "keep-booted",
      "maxUses": 20,
      "fallback": "erase"
    }
  },
  "limits": {
    "idlePoolCap": 2,
    "totalDeviceCap": 10,
    "sessionCap": 6,
    "maxConcurrentResetBoots": 2
  }
}
```

This is a configuration fragment, not a complete host config: include the
required `contractVersion` and `defaults.ios` policy from [the broker
experiment](session-broker-experiment.md). `iosClassifications` is optional and
defaults to `[]`; add classifications when the host's simulator inventory needs
them. Any `reuse.ios.mode` other than `off` requires `defaults.ios`. On current
main, use the legacy `reuseCleanDevices` value only if the deployed daemon
supports that schema; do not combine it with the preview mode block.

Android reuse is a separate opt-in and defaults off; enabling iOS reuse does
not enable it. The open Android lanes deliver separate `snapshot` and
`keep-booted` reset strategies. `androidResetMode: "snapshot"` restores an
emulator snapshot and can fall back to a same-device wipe-data replacement;
`androidResetMode: "keep-booted"` runs the Android cleaning operations below
and then checks health. Keep-booted's `androidKeepBootedMaxUses` defaults to 20.
An injected snapshot reset can be used as its fallback, and that reset may
itself fall back to wipe-data; otherwise a failed keep-booted reset requires
destruction. The keep-booted lane currently does not wire a snapshot fallback
in its host-config integration. The Android strategy integration is still in
progress; do not combine preview keys unless the deployed daemon schema accepts
them. Android `maxUses` currently sends the device to destruction unless a
fallback is injected; it does not periodically reset and retain the device.
`wipe-data` is not a selectable `androidResetMode`: it is the snapshot
strategy's internal fallback.

The first Android fragment illustrates the in-progress snapshot strategy; it
is not a complete host config. It also needs `contractVersion` and a
`defaults.android` policy from [the broker experiment](session-broker-experiment.md).
`androidResetTimeoutMs` is optional, defaults to 600,000 ms, and is valid only
with snapshot mode and Android reuse enabled. The second fragment illustrates
the keep-booted lane: `androidKeepBootedMaxUses` is optional and defaults to 20.
Both fragments are previews until their PRs and schema integration have merged.

```json
{
  "reuseAndroidCleanDevices": true,
  "androidResetMode": "snapshot",
  "androidResetTimeoutMs": 600000,
  "limits": {
    "idlePoolCap": 1,
    "totalDeviceCap": 7,
    "sessionCap": 4
  }
}
```

```json
{
  "reuseAndroidCleanDevices": true,
  "androidResetMode": "keep-booted",
  "androidKeepBootedMaxUses": 20
}
```

Each lane's host-config schema is strict. The iOS reuse block and Android reset
keys cannot be combined until a merged daemon schema explicitly accepts both;
use the complete schema supported by the deployed daemon.

## Admission and fallback order

Reuse is limited to an idle device compatible with the requested profile. The
iOS reset-readiness wait described here is preview behavior in the open iOS
cleaning PRs, not current main behavior. In those PRs, an iOS request may wait
for a compatible resetting device only when the same profile has reset p90 and
create/boot p50 samples from the last 24 hours. A resetting device qualifies
only when its positive p90 remaining-time estimate is no greater than the
shared cutoff: the minimum create p50 plus boot p50 across matching resetting
candidates with usable estimates. Because eligibility already enforces that
cutoff, the wait equals the remaining-time estimate and is then capped by the
request's preparation deadline. With no matching samples there is no wait. Only
one request can wait on a given resetting device at a time. Android does not
use this wait. Otherwise, normal creation is subject to the session,
total-device, and platform boot-gate limits. A cap or boot-gate limit does not
make a busy or incompatible device reusable.

The `maxConcurrentResetBoots` queue described here is also preview behavior in
the open iOS cleaning PRs, not current main behavior. In those PRs it queues
iOS reset boots; main does not currently have this queue.

On every keep-booted release below `maxUses`, the cleaning work runs before a
health check. A successful health check returns the device to the idle pool only
while ownership is still valid. Reaching `maxUses` skips cleaning and goes
straight to fallback: iOS erases; Android uses an injected snapshot fallback or
destroys the device. Android's current keep-booted host-config integration does
not inject that fallback, so reaching its `androidKeepBootedMaxUses` destroys
the device. In the open iOS cleaning PRs, re-running a release that has already
recorded a failure also skips cleaning. On those PRs, a journal-load failure or
an unsettled earlier native step fails release without running the erase
fallback; the resource remains pending or is destroyed. Failures during the
cleaning operations (or health check) reach the erase fallback. These details
describe the open PR behavior, not current main behavior. Ownership loss
prevents idle publication; cleanup and fallback must remain ownership-fenced,
so the broker may leave the resource pending or destroy it rather than run a
reset under a stale fence. For `off`, release destroys the device.

## Keep-booted cleaning operations

Keep-booted does not compare the resulting device with the captured baseline.
On every keep-booted release below `maxUses`, the cleaning operations are
attempted; unsupported journal reversions may be skipped, but there is no
all-mutation-kinds gate. Reaching `maxUses` skips cleaning and goes straight to
fallback. On iOS, a re-run after a recorded failure also skips cleaning.

- **iOS:** replay supported journal reversions, remove non-baseline apps and
  their removable app-group containers, reset keychain, reset all privacy
  grants, clear location and status-bar overrides and pasteboard, restore
  appearance/content-size/contrast and global locale-related preferences, then
  check the simulator's booted target and automation health endpoint. The
  baseline guides selected operations; it is not compared with the final state.
- **Android:** replay supported journal reversions; remove third-party packages
  absent from the pool-entry baseline; revoke newly granted runtime
  permissions for retained third-party apps; restore settings; remove added
  files beneath the supported shared-storage roots; clear clipboard when
  supported; then check boot completion, package-manager responsiveness and
  CtrlProxy health. Non-critical setting/revert errors may be logged and
  skipped; critical cleaning or health failures use fallback or destruction.
- **Fallback:** iOS uses erase. Android can use an injected snapshot reset,
  whose own fallback can be wipe-data; without an available fallback, the
  device is destroyed. The current keep-booted host-config integration does
  not wire a snapshot fallback. Successful fallback makes the resource
  eligible for idle reuse; failed fallback leaves it unavailable or destroys it.

Reset timings identify the work performed. iOS records journal, preflight
inventory, individual revert, sanitize, health and health-probe phases; native
commands are bounded at 10 seconds, the health HTTP probe at 5 seconds, and
reset steps default to 30 seconds.
Android keep-booted records journal, clean and health phases, with a default
30-second cleaning budget and a separate default 30-second fallback budget for
an injected fallback. Within a keep-booted fallback, that 30-second budget
bounds the snapshot and its wipe-data step instead of the snapshot strategy's
600,000 ms default.
Android snapshot uses phases such as identity, load, readiness, health, stop
and wipe-data launch; its overall timeout defaults to 600,000 ms. A keep-booted
fallback is reported as `fallback:snapshot` even if that snapshot strategy
itself falls back to wipe-data. Phase names are implementation details and may
evolve with the open PRs.

## What keep-booted does not clean

Keep-booted is best-effort cleanup. A successful cleaning run and health check
do not mean the device is equivalent to a freshly erased or wiped device.

- **iOS:** Photos, Contacts and Calendar additions are not removed. Baseline app
  data is not reset, and baseline app-group data can persist where shared
  containers are retained. Other unsupported or out-of-band state may remain.
- **Android:** Accounts are not removed, and baseline apps' data is not reset
  (there is no default `pm clear`). Existing baseline files that were
  overwritten or deleted are not restored; added files are only removed under the
  supported shared-storage roots. Other uninventoried state may remain.

Use `erase` on iOS or the Android `snapshot` strategy when a full reset
boundary is required. Wipe-data is snapshot's internal fallback, not a
selectable mode. Use `maxUses` to bound drift when keep-booted reuse is
acceptable; on iOS it periodically uses erase and retains the same device after
success, while Android currently destroys at the limit unless a fallback is
injected.

## Size caps independently

These limits control different resources:

- `sessionCap` limits active or acquiring sessions. Set it from the maximum
  simultaneous workload the host and its devices can serve.
- `totalDeviceCap` bounds all broker-owned native devices, including active,
  creating, idle, resetting, uncertain, and still-destroying resources. Leave
  recovery headroom; pending destruction remains charged until absence is
  confirmed.
- `idlePoolCap` limits devices retained between sessions. A larger idle pool
  makes a compatible warm device more likely, but consumes disk, memory, and
  simulator/emulator capacity while idle. Start with a small cap based on
  concurrent bursts and measured reuse demand, not the total device cap.
- The platform boot-gate limit bounds concurrent device boots (including
  creation/replacement work governed by that gate). It is distinct from the
  broker's device-count caps.
- `limits.maxConcurrentResetBoots` is a preview option from the open iOS
  cleaning PRs; it is not accepted by current main's strict host-config schema.
  In those PRs it queues iOS erase resets and the erase fallback from
  keep-booted mode, does not limit Android keep-booted cleanup, and is unlimited
  when omitted. Keep it at or below iOS safe boot concurrency so reset boots do
  not overwhelm the same host resources as fresh acquisitions.

A practical initial relationship is `totalDeviceCap >= sessionCap +
idlePoolCap`, plus any explicit allowance for in-flight creation or cleanup.
It is a capacity-planning target, not a promise that all slots can be used
simultaneously: transitions and uncertain cleanup also consume the total cap.
Reducing `idlePoolCap` does not evict devices immediately: idle trimming runs
when a device returns to idle. Separately, admission at the total-device cap
can evict the oldest idle device to make room, whether or not it matches the
request. Active or resetting devices are not evicted to satisfy an idle target.

### Worked sizing examples

No matched comparison currently establishes that reuse reduces end-to-end
latency. An idle-pool hit moves boot work from acquisition to release rather
than avoiding that work. For illustration only, assume creation p50 of about
107 seconds and p90 of about 124 seconds; these creation-time figures are
illustrative inputs, not measured repo facts. An iOS erase reset is reported as
approximately 15 seconds to stop, 0.3 seconds to erase, and 52 seconds to boot:
about 67.3 seconds total. Compare matched end-to-end acquisition and release
timings before concluding that reuse improves latency. These are planning
inputs, not qualification of the in-progress keep-booted implementations.

For a host serving up to six concurrent sessions and retaining two compatible
devices between demand peaks, a starting plan could be `sessionCap: 6`,
`idlePoolCap: 2`, and `totalDeviceCap: 10`, provided the host has resources for
ten devices. The two additional slots leave some headroom for creation in flight
or cleanup, though pending destruction continues to count until absence is
confirmed. If the iOS boot gate safely admits two boots at a time, set
`maxConcurrentResetBoots: 2` or lower. This preserves up to two warm devices
without raising concurrent session admission above six.

At a 67.3-second reset duration, two reset slots can finish a batch of ten
resets in roughly five waves, or 337 seconds, ignoring queueing and variation.
One reset slot takes about ten waves, or 673 seconds. If observed p90 reset
time is materially above the measured estimate, adjust reset concurrency,
`idlePoolCap`, or the client's preparation timeout based on observed demand and
request tolerance; raising reset concurrency only helps when the platform boot
gate and host have spare capacity.

In the open iOS cleaning PRs, if a compatible device is still resetting and
matching same-profile timing samples exist from the last 24 hours, admission may
wait for it only when its positive reset-p90 remaining-time estimate is no
greater than the shared cutoff (the minimum create-p50 plus boot-p50 across
matching resetting candidates with usable estimates). The wait equals that
remaining-time estimate and is bounded by the preparation deadline; only one
request can wait on that device. If the estimate timer fires first, normal
admission resumes; if the preparation deadline fires first, the request fails
with retryable `session_preparation_failed` instead. Current main does not have
this reset-readiness wait, and Android does not use it. Waiting is a bounded
opportunity to reuse, not a guarantee: reset failures follow the normal
fallback and cap rules.

## Read timing and stats

Acquire, release, and status replies expose a `timing` object. Use it to compare
the phases actually observed for each request instead of assuming every
acquisition paid the full creation cost or every release used the same reset
path. Correlate those timings with the daemon's `daemon/sessionBrokerStats`
report, which includes p50 and p90 summaries.

Use the measurements to tune in this order:

1. Compare create and reset p50/p90 for the same platform and compatible
   profile. If erase reset does not beat creation enough to matter, use `off`
   or reduce idle retention.
2. Compare reset p90 with the time requests can tolerate waiting and the
   client's preparation timeout; there is no separate wait-duration setting.
   Use reset concurrency, `idlePoolCap`, and the client timeout as the available
   tuning controls, and do not size only from p50.
3. Check idle-pool occupancy and reuse frequency. Raise `idlePoolCap` only when
   useful compatible demand regularly exceeds retained supply and the host has
   spare native-device capacity.
4. Compare concurrent reset demand with the boot gate and host pressure before
   increasing `maxConcurrentResetBoots`. Queued resets are inactive and cannot
   be waited on, so size reset concurrency for active reset work. A high wait
   p90 under saturated boot capacity is not fixed by increasing the total
   device cap alone.
5. Re-evaluate after each platform strategy changes. iOS erase, iOS
   keep-booted, Android snapshot, and Android keep-booted are distinct reset
   paths and should not share latency assumptions without measurements.

Treat p50 as typical work and p90 as a conservative operational budget, not as
a hard upper bound. Use a recent window with enough requests of the same mode
and profile; sparse samples and mixed reset modes can hide regressions. Keep
the device caps, reset concurrency, host boot gate, and fallback behavior
visible in the same operational review so a latency improvement does not come
at the cost of excess native capacity or unbounded residual state.
