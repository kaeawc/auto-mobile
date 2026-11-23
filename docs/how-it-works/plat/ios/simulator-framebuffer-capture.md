# iOS Simulator framebuffer capture

WebRTC and video streams of an iOS Simulator read the device's display framebuffer
through CoreSimulator. They need no Simulator or Device Hub window and no Screen
Recording permission. Source: `ios/screen-capture/Sources/ScreenCaptureHelper/`
(`SimulatorFramebuffer.swift`, `FramebufferCaptureSession.swift`) and
`src/features/webrtc/IosH264Source.ts`.

## Reading the framebuffer

`screen-capture-helper --simulator-udid <udid> --encode h264` resolves the main
display surface once at startup:

1. `SimServiceContext sharedServiceContextForDeveloperDir:error:`, then
   `defaultDeviceSetWithError:` and `devicesByUDID`. The device must be booted.
2. `-[SimDevice io]`, `-updateIOPorts`, `-ioPorts`.
3. Each port's `-descriptor`. Display descriptors respond to `-framebufferSurface`.
4. `-[descriptor state]` returns a `ROCKImmutableProxy`. Its `-displayClass` is
   `0` for the main display. Proxied methods are invisible to
   `responds(to:)`, so these two calls use a raw `objc_msgSend` cast.
5. `-framebufferSurface` returns the BGRA `IOSurface` at full device resolution
   (1206x2622 on iPhone 17, iOS 27.2).

Each `-framebufferSurface` call is an XPC round trip that returns a new wrapper for
the same surface ID. The helper holds the surface and fetches it again once a
second, so a rotation or display reconfiguration that replaces it is picked up.

## Encoding

A timer polls the surface at `--simulator-fps`. `IOSurfaceGetSeed` changes on
every frame CoreSimulator draws. `FramebufferFrameGate` encodes a frame only
when the seed or surface changes, or when the control channel requests a
keyframe. A static screen sends nothing until a viewer's PLI or the daemon's
liveness probe requests a keyframe, which re-encodes the unchanged surface.

On this path the helper never emits capture-idle. A static screen stays fresh
through keyframe requests: the gate re-encodes on any request, and a late joiner
gets `requestKeyFrameForWaitingSubscriber`.

The helper wraps the surface with `CVPixelBufferCreateWithIOSurface`, without a
copy, and feeds it to the shared `EncodePipeline`. Sizing follows the
physical-device path. The encoder targets H.264 Level 4.2 or `--max-long-side`,
and VideoToolbox scales the surface into it (970x2112 for a 1206x2622 surface).
The encoder reads the live surface, so a frame drawn during an encode can tear.

## Choosing the path

The production capture factory enables framebuffer capture. For a Simulator
stream without audio, `IosH264Source` starts the helper with the device UDID
first. If the helper exits or errors before its first record, the source logs a
warning and remembers the failure for its lifetime. It then uses the
ScreenCaptureKit window path. Two causes are a released helper without
`--simulator-udid` and a CoreSimulator API missing on that Xcode. Audio streams always use the window path, because
only ScreenCaptureKit captures Simulator audio. A failure after the first record
goes through the normal running reconnect, which tries the framebuffer again.

Background and measurements: [devlog](../../../devlog/2026-11-23-simulator-framebuffer-capture.md).
