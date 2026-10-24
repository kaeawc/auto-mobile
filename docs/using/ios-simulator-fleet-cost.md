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

The count limit is the smaller of two budgets, at least 1:

- Memory: half of host RAM divided by per-simulator settled process-tree RSS.
  The tree includes the CtrlProxy runner app, so no extra runner overhead is added.
  Measured RSS is averaged and clamped to 1.5–6 GiB; without measurements the
  default is 3 GiB. Boots in flight retain conservative memory charges until ready.
- Settled CPU: half of host cores divided by 0.055 core per simulator (0.04 for
  Apple processes plus 0.015 for AutoMobile, measured in #15097). The other half
  stays available for the app under test, IDE and runners.

Set `AUTOMOBILE_IOS_SIM_MAX_BOOTED` to override the count limit. Only count-limit
overflow fails immediately with the retryable `capacity_exhausted` error.

First boot has a separate concurrency limit: `ceil(host cores / 13)`, at least 2
(or 1 when host resources cannot be read). The floor of 2 matches the runner launch
limit: boots share the host's CPU-seconds, so serializing them gains little, while
a queue of one makes later callers wait out two full bursts. Measurements in #15097 show a burst
of about 13 cores for 50–130 seconds: about 790 CPU-seconds, or 222 CPU-seconds
with clone + lean preparation. Set `AUTOMOBILE_IOS_SIM_BOOT_CONCURRENCY` to
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
