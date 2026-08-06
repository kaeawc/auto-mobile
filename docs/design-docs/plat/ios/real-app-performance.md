# Real iOS-app performance measurement (spike)

<kbd>🔬 Spike</kbd>

> **Current state:** investigation for #5078. Records what does and does not work
> for measuring the *app under test's* real performance on the iOS Simulator, and
> the recommended path. No live per-app iOS fps/jank source ships yet.

## Problem

The observe `perfSnapshot` wants real per-app fps / frame-time / jank on iOS. The
existing on-device signal does not provide it:

- `ios/control-proxy/Sources/CtrlProxy/DisplayLinkFPSMonitor.swift` runs its
  `CADisplayLink` on the **XCUITest runner's** own main runloop. It measures how
  steadily that mostly-idle runner process is serviced against vsync — not the
  frames the app under test renders. It reads a clean 60/120 fps even while the
  app janks, and its `task_info` cpu/memory describe the runner.
- The app's **real** CPU/memory already come host-side from `ps`/`simctl` by
  bundle id (`PerformanceMonitor.sampleIOSDevice`), which is correct and kept.

Interim correctness (landed with the feature): the runner snapshot is no longer
fed into `perfSnapshot`, so an iOS snapshot carries real `cpu`/`memoryMb` and
`null` `fps`/`jank` rather than presenting runner health as app performance. It
still flows to the IDE stream unchanged.

## What was tried (Xcode 26 / xctrace 26.0, iPhone 16 Pro Simulator)

`xctrace` lists the relevant instruments (Core Animation FPS, Hitches, Frame
Lifetimes, Display, GPU, Metal) and its `record` help accepts a Simulator target
(`--device '<name> Simulator'`). However, recording the modern per-frame template
against the booted Simulator fails:

```
$ xcrun xctrace record --template "Animation Hitches" --device <sim-udid> \
    --all-processes --time-limit 6s --output hitches.trace
* [Error] Hitches is not supported on this platform.
```

The Simulator renders through the Mac's GPU and window server, so the on-device
frame-presentation / hitch instrumentation Apple exposes on real hardware is
**not available on the Simulator**, and any Metal/GPU timing that *does* record
there reflects the host Mac, not device-representative behavior.

## Options evaluated

| Source | Real app frames? | Simulator? | Live/streamable? | Verdict |
|---|---|---|---|---|
| CtrlProxy `CADisplayLink` (today) | ✗ runner cadence | ✓ | ✓ | Not app perf — dropped from `perfSnapshot` |
| `xctrace` Hitches / Frame Lifetimes | ✓ (device) | ✗ device-only | post-hoc `.trace` | Blocked on Simulator |
| `xctrace` Metal System Trace | GPU, host-bound on sim | ✓ but host GPU | post-hoc | Not device-representative; not live |
| MetricKit (`MXAnimationMetric`, hitch ratio) | ✓ aggregate | limited/delayed | ✗ (daily payloads) | Too coarse for a live window |
| **In-app SDK `CADisplayLink`/`CAMetalDisplayLink`** | ✓ **app's own** render loop | ✓ | ✓ (1s broadcast) | **Recommended** |
| Host `ps`/`simctl` cpu/mem (today) | ✓ (app process) | ✓ | ✓ | Keep — already real |

## Recommendation

1. **Real fps/jank = in-app SDK, on device and simulator alike.** An AutoMobile
   iOS SDK embedded in the target app runs a `CADisplayLink`/`CAMetalDisplayLink`
   (and, on device, hitch/`os_signpost` metrics) **in the app's own process** and
   broadcasts per-window fps/frame-time/jank to CtrlProxy, mirroring the Android
   SDK FrameMetrics feed (#5076). It funnels into `PerformanceMonitor.pushMetrics`,
   so `perfSnapshot` picks it up with no snapshot-layer change. This is the only
   source that measures the *app's* rendering on the Simulator. Caveat: on the
   Simulator even this reflects the host-driven refresh, not true device hardware
   — treat Simulator fps as directional, and prefer a physical device (where the
   SDK can also read hitch metrics) for fidelity-critical numbers.
2. **Keep host-side cpu/memory** by bundle id — already real, no change.
3. **Do not** invest in host-side `xctrace`/MetricKit for live per-frame data:
   the per-frame instruments are device-only, and MetricKit is aggregate/delayed.

The remaining implementation (iOS SDK frame collector + broadcast + host wiring)
is the open scope of #5078; the interim correctness fix and this decision unblock
it.
