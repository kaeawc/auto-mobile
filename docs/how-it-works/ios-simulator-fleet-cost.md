# iOS Simulator fleet cost measurement

How AutoMobile measures booted iOS Simulators and derives the capacity limits described in
[iOS Simulator fleet cost](../using/ios-simulator-fleet-cost.md). Measurement is read-only: it
runs `ps`, `sysctl -n kern.memorystatus_vm_pressure_level`, `top -l 1 -stats pid,mem` and
`xcrun simctl list devices -j`, and never boots, shuts down or reconfigures a simulator.

## What is measured

One host snapshot is taken per batch and shared by every simulator.

| Measurement                  | Source                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------- |
| Process memory footprint     | `top` `MEM` (`phys_footprint`) summed over the `ps` process tree of the simulator |
| Process memory (RSS) and CPU | `ps` process tree rooted at the process whose command names the device data dir   |
| Device data on disk          | `dataPathSize` from `simctl list devices -j` (no filesystem walk)                 |
| Host memory, cores, load     | `os` totals, 1-minute load average, macOS memory pressure level                   |
| Boot-to-ready duration       | Recorded boot durations, keyed by simulator and profile                           |

RSS counts shared pages (the dyld cache and system frameworks) once per process, and a
simulator tree has about 220 processes, so its summed RSS reads roughly ten times the real
cost: 26.9 GiB for one idle simulator whose `phys_footprint` is 2.1–2.4 GiB (#15288). Memory
cost is therefore the summed footprint, and RSS is only shown for reference. If the `top` read
fails, footprint is reported as unmeasured (with a `memory footprint:` error), never replaced by
RSS. `%CPU` is `ps`'s decayed ratio, not an instantaneous sample. A process claimed by two
simulators is attributed to neither.

Each simulator carries a `quality`: `measured`, `no-processes` (Booted but no process visible),
`not-running`, or `unavailable` (host snapshot failed, with the error). Missing data is never
reported as zero.

## Derived limits

- Memory budget: measured footprints are averaged and clamped to 1.5–6 GiB (the upper bound is
  only a sanity check); without measurements the default is 2.5 GiB. The process tree includes
  the CtrlProxy runner app, so no extra runner overhead is added. Round 6 ran 32 simulators
  healthy (normal memory pressure, no swap) at 75.8 GiB, 59% of a 128 GB host, so a 128 GB /
  16-core host derives 32 at the measured 2.4 GiB.
- CPU budget: 0.1 core per settled simulator (#15288 measured 0.07–0.115 at 5–20 minutes,
  drifting up with age; #15097 measured 0.055 in the first minutes).
- First-boot concurrency: #15097 measured a burst of about 13 cores for 50–130 seconds, about
  790 CPU-seconds, or 222 CPU-seconds with clone + lean preparation; hence `ceil(host cores /
  13)`. The floor of 2 matches the runner launch limit: boots share the host's CPU-seconds, so
  serializing them gains little, while a queue of one makes later callers wait out two full
  bursts.

## Template clones

`simctl clone` shares Safari and other system-app data between a clone and its template, so
state written in one clone would reach the template and other clones (#15327, tracked under
#15216). AutoMobile rewrites each clone after `simctl clone` so it owns its system-app data; a
clone whose rewrite fails is deleted and the simulator is created normally. Cloning stays off by
default until a manual test confirms isolation on a release candidate.
