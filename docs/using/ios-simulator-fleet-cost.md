# iOS Simulator fleet cost and capacity

AutoMobile measures what booted iOS Simulators cost the host (process-tree memory footprint,
CPU, device data size, boot time) and tells callers whether one more boot fits. Measurement is
read-only and never boots, shuts down or reconfigures a simulator. For how each value is
measured and how the limits below are derived, see
[fleet cost measurement](../how-it-works/ios-simulator-fleet-cost.md).

Each simulator carries a `quality`: `measured`, `no-processes` (Booted but no
process visible), `not-running`, or `unavailable` (host snapshot failed, with the
error). Missing data is never reported as zero.

## Capacity policy

The count limit is the smaller of two budgets, at least 1:

- Memory: 60% of host RAM divided by the measured per-simulator footprint (1.5–6 GiB,
  2.5 GiB before any measurement). Boots in flight keep conservative memory charges until
  ready. Host memory pressure is reported as `hostPressure`; it never raises the limit.
- Settled CPU: half of host cores divided by 0.1 core per simulator. The other half stays
  available for the app under test, IDE and runners. This does not bind below about 80
  simulators on 16 cores.

Set `AUTOMOBILE_IOS_SIM_MAX_BOOTED` to override the count limit. Only count-limit
overflow fails immediately with the retryable `capacity_exhausted` error.

The count covers every booted simulator, whatever its runtime. Apple Watch
simulators share it with iPhones and iPads: a `startDevice` or `provisionDevice`
that cold-boots a watch takes a slot and is refused with `capacity_exhausted`
at the limit.

First boot has a separate concurrency limit: `ceil(host cores / 13)`, at least 2
(or 1 when host resources cannot be read). Set `AUTOMOBILE_IOS_SIM_BOOT_CONCURRENCY` to
override this limit. Both overrides accept positive integers; invalid values
warn and use their derived limits.

Boots beyond the concurrency limit queue in FIFO order while retaining their
count slots, so queued boots count as in flight. Queue wait is outside the boot's
own time budget, but the caller's AbortSignal and outer deadline still apply.
Cancellation while queued releases the count slot. Because queued boots keep their
count slots, a caller can see `capacity_exhausted` while fewer simulators are actually
booted than the limit. The boot-concurrency limit applies only while the capacity gate
is enabled; `AUTOMOBILE_BOOT_CAPACITY_GATE=0` also removes boot staggering.

The boot permit covers boot-to-ready and is released before runner launch.
The separate runner launch limit (`AUTOMOBILE_IOS_RUNNER_LAUNCH_CONCURRENCY`,
default 2 per daemon) paces expensive runner launches after the simulator is
Booted. These limits guard different resources and are never held nested.
See [Boot capacity](environment-variables.md#boot-capacity) for the opt-out and
the shared Android gate.

A broker reset that re-boots a simulator it already holds booted keeps that
simulator's own slot and is never refused because other simulators fill the cap.

A broker reset re-booting its erased simulator waits at most 60 seconds with
backoff for capacity. It then fails with `reset_capacity_wait_exceeded`, naming
simulators with no AutoMobile owner that hold the cap. The broker destroys the
unrecoverable device instead of retrying forever. Shut down the named simulators
with `xcrun simctl shutdown <udid>` or raise `AUTOMOBILE_IOS_SIM_MAX_BOOTED`.

Before a boot, the capacity check answers with one of:

- `reuse-warm`: a booted simulator matches the requested device type, runtime and/or profile
  (excluding devices the caller marks busy). Reuse it instead of booting.
- `refuse` with `at-capacity`: the booted count has reached the limit.
- `allow`: a new boot fits. Only the booted-device count limit refuses a boot; host
  memory/CPU pressure never does. Memory pressure (warn/critical) or load of at least 1.5 per core
  for 3 consecutive samples is reported as `hostPressure` in the capacity snapshot
  instead.

An admitted boot holds its slot until it finishes; a refused boot fails with `capacity_exhausted`.

## Surfaces

- `auto-mobile --cli doctor` (macOS): the "iOS Simulator Fleet Cost" check lists each booted
  simulator's memory, CPU, data size and last boot time, and warns when a new boot would exceed capacity.

Doctor also reports advisory Spotlight indexing warnings for existing developer directories on macOS.
Generated scratch, build, and bootstrapped worktree roots receive `.metadata_never_index` markers.
Set `AUTOMOBILE_SPOTLIGHT_EXCLUDE=0` to opt out of shell marker creation.
For other developer directories, add a marker or use System Settings > Spotlight > Search Privacy.
Doctor only reads indexing status and never changes system settings.

New simulators use the `minimal` lean profile by default; settled template cloning is off by default.
Set `AUTOMOBILE_IOS_PREBOOT_LEAN_PROFILE=none` to opt out of the profile, or
`AUTOMOBILE_IOS_TEMPLATE_CLONE=1` (or `true`) to opt in to cloning. Explicit
resource requests override the profile.

### Known limitation: template clones

Template cloning is off by default for this release: clones of a template could share Safari and
other system-app data (tabs, history, cookies, website data). With
`AUTOMOBILE_IOS_TEMPLATE_CLONE=1`, a clone whose isolation step fails is deleted and the
simulator is created normally.
