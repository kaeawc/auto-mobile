# iOS WebRTC (WHIP) Live Streaming

<kbd>🚧 In Progress</kbd>

> **Current state:** WebRTC streaming (`webrtc-stream.sock`,
> [webrtc-streaming.md](./webrtc-streaming.md)) supports Android and has an iOS
> capture source built from the macOS `screen-capture-helper` plus local `ffmpeg`
> H.264 encoding. This document records the empirical findings that ruled out
> raw `simctl` streaming and the remaining iOS delivery constraints. See the
> [Status Glossary](../../status-glossary.md) for chip definitions.

The WebRTC, RTP, and WHIP behavior shared with Android is mapped to its public
standards in the [WebRTC standards map](./webrtc-standards-map.md). This document
only covers the iOS capture and encoding boundary.

Follow-up to #3751; addresses #3777.

## Goal

Produce a **continuous H.264 Annex-B elementary stream** for iOS that plugs into
the existing `WebRtcPublisher` **unchanged** — i.e. a new capture source that
satisfies the same contract the Android sources do:

```ts
interface H264CaptureSource {
  start(): Promise<void>;
  stop(): Promise<void>;
}
// feeding: onData(chunk: Buffer /* Annex-B */) => void
```

The publisher / RTP packetizer / WHIP / reconnect stack stays untouched — the
iOS integration is a capture source that feeds the same H.264 chunk callback.

## Why the guard exists: the blocker is real

Android has `adb exec-out screenrecord --output-format=h264 -` (and now the
persistent `video-server` encoder, #3776): a live Annex-B byte stream on stdout.
iOS has **no drop-in equivalent**. Empirically verified on macOS with a booted
`iPhone 16 Pro` simulator (Xcode simctl):

| Candidate                                                             | Result                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xcrun simctl io <udid> recordVideo --codec h264 --force /dev/stdout` | **Fails**: `Couldn't create an asset writer … simctl.SimulatorError.allocationError`. `AVAssetWriter` requires a seekable file; it cannot target a pipe.                                                                           |
| `recordVideo … out.mov` then remux live                               | **Not live**: writes a QuickTime container whose `moov` atom is finalized only on clean `SIGINT` (see [iOS simctl moov atom flush]). A growing MOV cannot be `-c:v copy`-streamed.                                                 |
| `ffmpeg -f avfoundation -list_devices`                                | Only exposes **`Capture screen 0`** (the whole Mac display) — there is **no per-simulator capture device**. Whole-screen capture + window-cropping is the wrong scope (captures unrelated content), permission-gated, and brittle. |

So `simctl` provides screenshots and finalized recordings, not a live elementary
stream — exactly the premise of #3777.

## Options

### 1. Mac helper capture + local ffmpeg encoder — current implementation

The repo already has `ios/screen-capture`, a macOS Swift helper that emits
continuous BGRA frames for:

- **Physical devices** via AVFoundation USB capture.
- **Simulators** via ScreenCaptureKit simulator-window capture.

When WebRTC audio is explicitly enabled, the Simulator helper also captures
the selected window's audio through ScreenCaptureKit and multiplexes 8 kHz mono
PCM16LE records over its existing stdout transport. `IosH264Source` forwards
those chunks to the shared PCMU packetizer unchanged. Physical iOS playback
audio remains unavailable through public APIs and fails with an actionable
error rather than silently publishing video-only.

`IosH264Source` wraps that helper, pipes frames into `ffmpeg` with
`h264_videotoolbox`, and forwards raw H.264 Annex-B stdout chunks into the
existing `WebRtcPublisher`. The helper is a sha256-verified signed universal
archive downloaded from the matching GitHub Release and cached under
`~/.auto-mobile/screen-capture-helper/` ([#4392](https://github.com/kaeawc/auto-mobile/issues/4392)), so a normal macOS install
needs no Swift toolchain. The Swift package source is **not** shipped in the npm
payload. For local Swift development, build it in a checkout and set
`AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER` explicitly. ffmpeg is resolved from
`AUTOMOBILE_IOS_WEBRTC_FFMPEG` or `PATH`, and startup fails fast if ffmpeg or
`h264_videotoolbox` is unavailable
or if simulator capture reports missing Screen Recording permission before the
first frame.

### 2. VideoToolbox encoder in the CtrlProxy runner

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

### 3. On-Mac encoder outside the existing helper

A standalone Mac helper (Swift + VideoToolbox, or an `ffmpeg` pipeline) feeding
the same `onData`. The current implementation uses the existing
`screen-capture-helper` rather than adding another helper binary.

### 4. Physical device only

The AVFoundation USB-capture path works without ScreenCaptureKit simulator
window matching, but it does **not** cover simulators, which are the common
CI/dev case, so it is only a partial answer.

## Recommended increment

1. Ship the helper + ffmpeg `IosH264Source` path for physical devices and
   visible simulator windows.
2. Add end-to-end manual coverage against a WHIP fanout server (MediaMTX) on a Mac
   with Screen Recording permission granted.
3. Consider moving H.264 encoding into Swift (`VTCompressionSession`) once the
   helper path is proven, reducing the external `ffmpeg` dependency.

## Scope note

Nothing here touches `WebRtcPublisher`, the RTP packetizer, WHIP, or reconnect —
those are platform-agnostic. The only new surface is the capture source and the
availability-gated guard.

[iOS simctl moov atom flush]: ../../../../CLAUDE.md
[iOS runner release delivery gate]: ../../plat/ios/ctrl-proxy-ios.md
