# iOS WebRTC (WHIP) Live Streaming

<kbd>🚧 Design Only</kbd>

> **Current state:** Spike / design. WebRTC streaming (`webrtc-stream.sock`,
> [webrtc-streaming.md](./webrtc-streaming.md)) is **Android-only**;
> `startWebRtcStream` rejects iOS. This document scopes what an iOS source needs
> to satisfy the existing publisher, records the empirical findings that rule out
> the "easy" on-Mac paths, and recommends the implementation path. See the
> [Status Glossary](../../status-glossary.md) for chip definitions.

Follow-up to #3751; addresses #3777.

## Goal

Produce a **continuous H.264 Annex-B elementary stream** for iOS that plugs into
the existing `WebRtcPublisher` **unchanged** — i.e. a new capture source that
satisfies the same contract the Android sources do:

```ts
interface H264CaptureSource { start(): Promise<void>; stop(): Promise<void>; }
// feeding: onData(chunk: Buffer /* Annex-B */) => void
```

…then drop the Android-only guard in `webrtcStreamManager.startWebRtcStream`.
The publisher / RTP packetizer / WHIP / reconnect stack stays untouched — this is
purely a new source plus removing the guard once a source exists.

## Why the guard exists: the blocker is real

Android has `adb exec-out screenrecord --output-format=h264 -` (and now the
persistent `video-server` encoder, #3776): a live Annex-B byte stream on stdout.
iOS has **no drop-in equivalent**. Empirically verified on macOS with a booted
`iPhone 16 Pro` simulator (Xcode simctl):

| Candidate | Result |
|-----------|--------|
| `xcrun simctl io <udid> recordVideo --codec h264 --force /dev/stdout` | **Fails**: `Couldn't create an asset writer … simctl.SimulatorError.allocationError`. `AVAssetWriter` requires a seekable file; it cannot target a pipe. |
| `recordVideo … out.mov` then remux live | **Not live**: writes a QuickTime container whose `moov` atom is finalized only on clean `SIGINT` (see [iOS simctl moov atom flush]). A growing MOV cannot be `-c:v copy`-streamed. |
| `ffmpeg -f avfoundation -list_devices` | Only exposes **`Capture screen 0`** (the whole Mac display) — there is **no per-simulator capture device**. Whole-screen capture + window-cropping is the wrong scope (captures unrelated content), permission-gated, and brittle. |

So `simctl` provides screenshots and finalized recordings, not a live elementary
stream — exactly the premise of #3777.

## Options

### 1. VideoToolbox encoder in the CtrlProxy runner — recommended

Encode on the Mac inside the iOS CtrlProxy runner (`Sources/CtrlProxy`, see
[ctrl-proxy-ios.md](../../plat/ios/ctrl-proxy-ios.md)), where frames are already
reachable:

- **Physical devices**: appear as an AVFoundation capture source over USB (the
  QuickTime mechanism), documented in
  [ios/screen-streaming.md](../../plat/ios/screen-streaming.md). Feed
  `CMSampleBuffer`s into a `VTCompressionSession` (H.264, baseline, Annex-B) and
  emit the elementary stream over the runner's socket.
- **Simulators**: no AVFoundation device exists; frames come from the
  CoreSimulator framebuffer (`SimDeviceIOClient` / `IOSurface`), then the same
  `VTCompressionSession`.

The runner emits Annex-B framed like the Android `video-server`
([VideoServerStreamParser](../../../../src/features/webrtc/VideoServerStreamParser.ts)
already parses that framing), so the TS side is a thin `IosH264Source`
implementing `H264CaptureSource`: connect to the runner's stream socket, forward
payloads to `onData`.

**Cost / gate:** this is a runner change and therefore rides the **iOS runner
release delivery gate** — `Sources/CtrlProxy` changes require re-cutting the
runner bundle before they reach users (see [iOS runner release delivery gate]).

### 2. On-Mac encoder outside the runner

A standalone Mac helper (Swift + VideoToolbox, or an `ffmpeg` pipeline) feeding
the same `onData`. Rejected for simulators: there is no per-simulator AVFoundation
device (see table above), so the helper would still need the CoreSimulator
framebuffer — i.e. the same private-framework work as option 1, minus the runner's
existing plumbing.

### 3. Physical device only

The AVFoundation USB-capture path (option 1, physical branch) works without any
private simulator APIs and is the smallest first increment. It does **not** cover
simulators, which are the common CI/dev case, so it is a partial answer.

## Recommended increment

1. Add the `VTCompressionSession` encoder to the CtrlProxy runner, emitting
   Annex-B over a stream socket using the existing `video-server` framing.
2. Add a TS `IosH264Source implements H264CaptureSource` that connects to that
   socket and forwards payloads to `onData` (mirrors
   `PersistentEncoderH264Source`; unit-testable with fakes).
3. Gate the platform check on **source availability**, not platform: replace the
   hard `platform !== "android"` reject with a source-factory that returns an iOS
   source when the runner supports the stream, else a clear "not available"
   error. This keeps a working fallback story identical to the Android
   persistent-vs-screenrecord selection.
4. Re-cut the runner release so the encoder ships.

Start with the physical-device branch (option 3) to validate the encoder + RTP
path end-to-end, then add the simulator framebuffer source.

## Scope note

Nothing here touches `WebRtcPublisher`, the RTP packetizer, WHIP, or reconnect —
those are platform-agnostic. The only new surface is the capture source and the
availability-gated guard.

[iOS simctl moov atom flush]: ../../../../CLAUDE.md
[iOS runner release delivery gate]: ../../plat/ios/ctrl-proxy-ios.md
