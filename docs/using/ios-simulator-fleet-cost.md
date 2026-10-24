# iOS Simulator fleet cost and capacity

AutoMobile measures what booted iOS Simulators cost the host and tells callers
whether one more boot fits. Everything is read-only: it runs `ps`,
`sysctl -n kern.memorystatus_vm_pressure_level` and `xcrun simctl list devices -j`,
and never boots, shuts down or reconfigures a simulator.

## What is measured

One host snapshot is taken per batch and shared by every simulator.

| Measurement                  | Source                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------- |
| Process memory (RSS) and CPU | `ps` process tree rooted at the process whose command names the device data dir |
| Device data on disk          | `dataPathSize` from `simctl list devices -j` (no filesystem walk)               |
| Host memory, cores, load     | `os` totals, 1-minute load average, macOS memory pressure level                 |
| Boot-to-ready duration       | Recorded boot durations, keyed by simulator and profile                         |

RSS counts shared pages once per process, so it over-states the true footprint
slightly; `%CPU` is `ps`'s decayed ratio, not an instantaneous sample. A process
claimed by two simulators is attributed to neither.

Each simulator carries a `quality`: `measured`, `no-processes` (Booted but no
process visible), `not-running`, or `unavailable` (host snapshot failed, with the
error). Missing data is never reported as zero.

## Capacity policy

The limit on concurrently booted simulators is the smaller of a memory budget
(half of host RAM divided by the per-simulator RSS, measured when available,
clamped to 1.5-6 GiB, default 3 GiB) and a core budget (cores / 2), at least 1.
Set `AUTOMOBILE_IOS_SIM_MAX_BOOTED` to override.

Simulator boots go through this gate by default; a boot that finds the
platform at its limit fails at once with the retryable `capacity_exhausted` error
(it is not queued). See
[Boot capacity](environment-variables.md#boot-capacity) for the opt-out and the
shared Android gate.

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
