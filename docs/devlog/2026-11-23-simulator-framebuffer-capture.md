# Capture Simulator video from the device framebuffer

- Kind: decision
- Date: 2026-11-23
- Source: #19015
- Shaped: [iOS Simulator framebuffer capture](../how-it-works/plat/ios/simulator-framebuffer-capture.md)

## Context

iOS Simulator streams captured a Simulator.app (Xcode 27: Device Hub) window with
ScreenCaptureKit. That needs a visible window and the Screen Recording permission,
and fails when the window cannot be found (#12708, #8173). A headless Simulator
has no window, so its stream failed: on an iPhone 17 / iOS 27.2 Simulator booted
with `simctl` and Xcode 27.2, the window path gave up after 1972 ms with no
windows seen.

CoreSimulator exposes the main display as an `IOSurface`, reachable from
`-[SimDevice io]` without any window.

## Options

- Keep ScreenCaptureKit window capture only.
- Read the framebuffer IOSurface by polling its seed and encode it in the existing
  helper.
- Register for CoreSimulator's push callbacks
  (`registerCallbackWithUUID:ioSurfacesChangeCallback:` and
  `damageRectanglesCallback:`) instead of polling.

## Decision

Poll the framebuffer IOSurface seed at the stream fps in `screen-capture-helper`
(`--simulator-udid`) and keep ScreenCaptureKit as the fallback and the only audio
path. Polling feeds the existing `EncodePipeline` and needs no further private
callback signatures. The push callbacks stay unused.

Measured on the same host (Xcode 27.2, iPhone 17, iOS 27.2, host load average
200 to 640):

| Path                                      | Result                                       |
| ----------------------------------------- | -------------------------------------------- |
| Window capture, headless Simulator        | Fails after 1972 ms, no window               |
| Framebuffer helper, spawn to first record | 246 to 491 ms                                |
| `IosH264Source.start()` with framebuffer  | 329 ms, 54 frames in 6 s at 30 fps, 970x2112 |
| Framebuffer helper, static screen for 4 s | 2 records (first frame, one forced keyframe) |
| `-framebufferSurface` call                | 384 µs                                       |

Screenshots were not moved. `simctl io screenshot` already needs no window (about
470 to 540 ms per warm call); a PNG encoded from the surface in-process took 94 to
155 ms after 110 to 820 ms of CoreSimulator setup. The images had the same size;
11.7% of pixels differed by more than 8/255, mostly the Dynamic Island (black in
the framebuffer, wallpaper in `simctl`) and small color shifts in saturated areas.

## Consequences

Simulator video streams work headless and without the Screen Recording
permission. The helper depends on private CoreSimulator selectors; a missing
selector fails the framebuffer attempt and the stream falls back to the window.
Until a helper with `simulator-framebuffer` is released, a released helper rejects
`--simulator-udid` once per source before the fallback.
