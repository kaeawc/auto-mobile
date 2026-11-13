# iOS Simulator fleet capacity measurements

- Kind: concept
- Date: 2026-11-13
- Source: moved from `using/ios-simulator-fleet-cost.md` (#18140); #15288, #15097, #15327, #15216
- Shaped: [iOS Simulator fleet cost measurement](../how-it-works/ios-simulator-fleet-cost.md)

## Memory: footprint, not RSS

A simulator process tree has about 220 processes, and RSS counts shared pages (the dyld cache
and system frameworks) once per process. Summed RSS read 26.9 GiB for one idle simulator whose
`phys_footprint` was 2.1–2.4 GiB (#15288), so memory cost uses the summed footprint.

Round 6 ran 32 simulators healthy (normal memory pressure, no swap) at 75.8 GiB, 59% of a
128 GB host. At the measured 2.4 GiB, a 128 GB / 16-core host derives 32 from the 60% memory
budget.

## CPU

Settled CPU per simulator measured 0.07–0.115 cores at 5–20 minutes, drifting up with age
(#15288), and 0.055 in the first minutes (#15097), so the CPU budget charges 0.1 core per
simulator.

A first boot bursts to about 13 cores for 50–130 seconds: about 790 CPU-seconds, or 222
CPU-seconds with clone + lean preparation (#15097, see
[Simulator first-boot CPU measurements](2026-10-24-simulator-load-reduction-measurements.md)).
That gives the `ceil(host cores / 13)` first-boot limit. Its floor of 2 matches the runner launch
limit: boots share the host's CPU-seconds, so serializing them gains little, while a queue of one
makes later callers wait out two full bursts.

## Template clone isolation

A clone used to share Safari and other system-app data with its template, so state written in
one clone leaked to the template and to other clones (#15327, tracked under #15216). Clones are
now rewritten after `simctl clone`; cloning stays off by default until a manual test confirms
isolation on a release candidate. See
[Lean profile and template clone defaults](2026-10-24-simulator-load-reduction-defaults.md).
