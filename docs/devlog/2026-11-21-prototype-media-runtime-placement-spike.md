# Prototype media runtime placement spike

- Kind: decision
- Date: 2026-11-21
- Source: PR #18682 (part of #14247), moved from the how-it-works page in #18837
- Shaped: [Prototype media runtime placement](../how-it-works/prototype-media.md)

## Context

Prototypes need video and audio playback. #14247 asked where the player runtime lives, what it
costs in CtrlProxy, and which formats each simulator or emulator decodes. PR #18682 answered with a
time-boxed spike on an Apple M3 Max host (arm64, Xcode 26.6).

## Options

- Link core `media3-exoplayer` into CtrlProxy for inline overlay video.
- Also link `media3-ui-compose` into CtrlProxy to render the overlay through `PlayerSurface`.
- Keep all playback in ProtoViewer or a disposable app.

## Decision

CtrlProxy links core `media3-exoplayer` only, because the measured cost is small (+139 KiB, +2.0%).
`media3-ui-compose` stays optional (+155 KiB total). HLS, DASH, MediaSession, notification controls
and caching go to ProtoViewer or a disposable app. Per-platform format warnings come from the
decode matrices below.

## Consequences

- CtrlProxy never pulls HLS, DASH, `session` or `ui` Media3 artifacts.
- Validation warns on containers and codecs that fail on a platform, and CI asserts decoder output
  and player state instead of real-time playback progress.

## Measurements

### Release APK size (CtrlProxy, R8 minified)

`:control-proxy:assembleRelease`, Media3 1.11.1. Each variant adds a kept class that calls
`ExoPlayer.Builder(context).build()` (and for the last row `PlayerSurface` with a texture surface),
so R8 cannot strip the library as unused.

| Variant                             |     Bytes |    Delta | Delta % |
| ----------------------------------- | --------: | -------: | ------: |
| Baseline                            | 7,074,842 |        - |       - |
| `+ media3-exoplayer`                | 7,217,477 | +139 KiB |   +2.0% |
| `+ media3-exoplayer` + `ui-compose` | 7,233,861 | +155 KiB |   +2.2% |

We did not measure `media3-exoplayer-hls`, `-dash` or `media3-session` because the offline Gradle
cache lacks them, and CtrlProxy excludes HLS and DASH. Media3 ExoPlayer needs no native
libraries, so the delta is DEX only. We did not measure the ProtoViewer app shell.

### Android decode matrix

Measured with `MediaExtractor` + `MediaCodec` (every sample decoded to end of stream) from a shell
`app_process`, using 2 s 320x240 clips from ffmpeg. Images: Google APIs arm64-v8a, `-gpu
swiftshader_indirect`, `-no-window`. This host has no x86_64 images, so the x86_64 / API 30 / API 37
rows in the original plan were not run.

| Format                  | API 34 (`-no-audio`)                | API 36 (audio on)                       |
| ----------------------- | ----------------------------------- | --------------------------------------- |
| H.264 in MP4 / MKV      | pass, `c2.goldfish.h264` (hardware) | pass, `c2.goldfish.h264` (hardware)     |
| HEVC in MP4             | pass, `c2.android.hevc` (software)  | pass, `c2.goldfish.hevc` (hardware)     |
| VP9 in WebM             | pass, `c2.goldfish.vp9` (hardware)  | pass, `c2.goldfish.vp9` (hardware)      |
| AV1 in MP4 / WebM       | pass, `c2.android.av1` (software)   | pass, `c2.android.av1-dav1d` (software) |
| AAC (MP4 / M4A)         | pass, `c2.android.aac`              | pass, `c2.android.aac`                  |
| Opus (WebM / MKV / Ogg) | pass, `c2.android.opus`             | pass, `c2.android.opus`                 |
| MP3                     | pass, `c2.android.mp3`              | pass, `c2.android.mp3`                  |
| WebVTT                  | not testable here (see below)       | not testable here                       |

Platform `MediaExtractor` reports a `mov_text` track as `text/3gpp-tt` and does not decode it; subtitles
are rendered by the player library, not the platform codecs. The HLS playlist and DASH were not
played (they need the Media3 HLS/DASH artifacts).

#### Audio output

An `AudioTrack` that was written 1 s of PCM and played reported `getPlaybackHeadPosition()` of
44100 after 0.5 s and after 1.0 s, on both `-no-audio` (API 34) and audio-enabled (API 36)
emulators. The head jumps to the end of the buffer instead of advancing in real time, so playback
position is not a reliable real-time clock on emulators. CI should assert decoder output and
player state, not wall-clock `currentPosition` progress.

### iOS simulator matrix

iPhone 17 Pro, iOS 26.5 simulator, probe binary run with `simctl spawn` using `AVURLAsset`,
`AVAssetReader` (decode all samples) and `AVPlayer`.

| Format                  | Result                                                     |
| ----------------------- | ---------------------------------------------------------- |
| H.264 + AAC in MP4      | playable; 30 video frames and 88,200 audio samples decoded |
| HEVC + AAC in MP4       | playable; 30 frames decoded                                |
| AV1 + AAC in MP4        | `isPlayable` false                                         |
| VP9 / AV1 in WebM       | "Cannot Open" (WebM rejected)                              |
| H.264 + Opus in MKV     | "Cannot Open" (MKV rejected)                               |
| AAC (M4A), MP3          | playable; audio samples decoded                            |
| Opus in Ogg             | playable; audio samples decoded                            |
| `mov_text` in MP4       | `sbtl` track present, MP4 still plays                      |
| HLS (file URL playlist) | `isPlayable` true                                          |

AV1 may depend on host hardware; the host here is an M3 Max and the simulator still reported it
unplayable. Audio output: `AVAudioEngine` starts, `AVAudioPlayer` advances its clock
(`currentTime` 0.79 s after 0.8 s), and `AVPlayer` advances (0.89 s after 1.2 s of run loop).

### Not measured

- Picture-in-picture: `isPictureInPictureSupported()` returned false in a command-line process,
  which says nothing about an app with the required background modes. Background audio and Now
  Playing visibility in the injected agent, the Playground (`voip` only) and a Viewer template with
  `audio` were not run.
- Overlay `SurfaceView` versus `TextureView` inside a `TYPE_ACCESSIBILITY_OVERLAY` window.
- HLS and DASH playback on Android, `media3-session` size, API 30 and API 37 images, x86_64.
