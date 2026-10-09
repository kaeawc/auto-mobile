# iOS Simulator fleet cost and capacity

AutoMobile measures what booted iOS Simulators cost the host and tells callers
whether one more boot fits (#6696). Everything is read-only: it runs `ps`,
`sysctl -n kern.memorystatus_vm_pressure_level` and `xcrun simctl list devices -j`,
and never boots, shuts down or reconfigures a simulator.

## What is measured

One host snapshot is taken per batch and shared by every simulator.

| Measurement                  | Source                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------- |
| Process memory (RSS) and CPU | `ps` process tree rooted at the process whose command names the device data dir |
| Device data on disk          | `dataPathSize` from `simctl list devices -j` (no filesystem walk)               |
| Host memory, cores, load     | `os` totals, 1-minute load average, macOS memory pressure level                 |
| Boot-to-ready duration       | `BootDurationHistory` samples, keyed by simulator and profile identity          |

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

`SimulatorCapacityGate.evaluateBoot(request)` answers with:

- `reuse-warm`: a booted simulator matches the requested device type, runtime and/or profile
  (excluding devices the caller marks busy). Reuse it instead of booting.
- `queue` with `at-capacity`: the booted count has reached the limit.
- `queue` with `sustained-pressure`: the host reported memory pressure (warn/critical) or load of
  at least 1.5 per core for 3 consecutive samples while other simulators are booted.
- `allow`: a new boot fits. The first boot is never deferred by pressure.

`waitForCapacity(request, { deadlineMs, signal })` polls with the injected timer until the
decision is no longer `queue`, the absolute deadline would be exceeded, or the signal aborts.
Sampling is single-flight and independent of sessions, device epochs and runner readiness.

## Surfaces

- `auto-mobile --cli doctor` (macOS): the "iOS Simulator Fleet Cost" check lists each booted
  simulator's memory, CPU, data size and last boot time, and warns when a new boot would exceed capacity.
- Daemon-internal: `IosSimCapacityGate` and the optional `IosSimFleetMonitor` in
  `src/features/iosSimFleet/`. The simulator preparation lifecycle (#6695) is expected to call the gate
  and record boot durations via `BootDurationHistory`.
