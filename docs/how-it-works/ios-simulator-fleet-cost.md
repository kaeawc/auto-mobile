# iOS Simulator fleet cost measurement

How AutoMobile measures booted iOS Simulators and derives the capacity limits described in
[iOS Simulator fleet cost](../using/ios-simulator-fleet-cost.md). Measurement is read-only: it
runs `ps`, `sysctl -n kern.memorystatus_vm_pressure_level`, `top -l 1 -stats pid,mem` and
`xcrun simctl list devices -j`, and never boots, shuts down or reconfigures a simulator. The
measurements behind the constants are in
[iOS Simulator fleet capacity measurements](../devlog/2026-11-13-ios-simulator-fleet-capacity-measurements.md).

## What is measured

One host snapshot is taken per batch and shared by every simulator.

| Measurement                  | Source                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------- |
| Process memory footprint     | `top` `MEM` (`phys_footprint`) summed over the `ps` process tree of the simulator |
| Process memory (RSS) and CPU | `ps` process tree rooted at the process whose command names the device data dir   |
| Device data on disk          | `dataPathSize` from `simctl list devices -j` (no filesystem walk)                 |
| Host memory, cores, load     | `os` totals, 1-minute load average, macOS memory pressure level                   |
| Boot-to-ready duration       | Recorded boot durations, keyed by simulator and profile                           |

Memory cost is the summed footprint; RSS over-counts shared pages and is shown for reference
only. If the `top` read fails, footprint is reported as unmeasured (with a `memory footprint:`
error), never replaced by RSS. `%CPU` is `ps`'s decayed ratio, not an instantaneous sample. A
process claimed by two simulators is attributed to neither.

Each simulator carries a `quality`: `measured`, `no-processes` (Booted but no process visible),
`not-running`, or `unavailable` (host snapshot failed, with the error). Missing data is never
reported as zero.

## Derived limits

- Memory budget: 60% of host RAM divided by the average measured footprint, clamped to 1.5–6 GiB
  (the upper bound is only a sanity check); 2.5 GiB without measurements. The process tree
  includes the CtrlProxy runner app, so no extra runner overhead is added.
- CPU budget: half of host cores divided by 0.1 core per settled simulator.
- First-boot concurrency: `ceil(host cores / 13)`, at least 2 (1 when host resources cannot be
  read).

## Template clones

AutoMobile rewrites each clone after `simctl clone` so it owns its Safari and other system-app
data instead of sharing them with its template. A clone whose rewrite fails is deleted and the
simulator is created normally. Cloning is off by default.
