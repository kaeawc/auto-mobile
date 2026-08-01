# Video Recording

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

> **Current state:** `videoRecording` MCP tool is fully implemented. Supports Android (via `automobile-video.dex` VirtualDisplay + MediaCodec H.264) and iOS simulator (via `simctl io recordVideo`). Highlights, archive management, and Unix socket config are all implemented. See the [Status Glossary](../../status-glossary.md) for chip definitions.

Optional screen recording for debugging, performance analysis, and CI artifacts. Recording is off by default
and optimized for low overhead with a low-quality default preset.

## Goals

- Provide on-demand device/simulator video recordings via MCP tools.
- Default to low quality to minimize CPU, GPU, and IO overhead.
- Allow explicit configuration of target bitrate and max throughput.
- Enforce a maximum total archive size with automatic eviction.
- Prefer the highest-performance libraries available on both macOS and Linux.

## Non-goals

- Continuous always-on recording.
- High-quality marketing or demo capture (use external tools instead).

## Configuration

Defaults should be conservative and low-quality:

- `qualityPreset`: `low` (default)
- `targetBitrateKbps`: 1000
- `maxThroughputMbps`: 5
- `fps`: 15
- `maxArchiveSizeMb`: 100
- `format`: `mp4` (H.264 baseline)

Example config payload:

```json
{
  "qualityPreset": "low",
  "targetBitrateKbps": 1000,
  "maxThroughputMbps": 5,
  "fps": 15,
  "maxArchiveSizeMb": 100,
  "format": "mp4"
}
```

`maxThroughputMbps` caps encoded throughput (bitrate * fps * resolution) by adjusting capture settings.

## MCP Tools

- `videoRecording`
  - Params:
    - `action`: `start` or `stop`.
    - `platform`: `android` or `ios`.
    - `deviceId`/`sessionUuid`/`device`: optional device targeting. If omitted, the action applies to all devices on the platform.
    - `recordingId`: optional (stop only).
    - `highlights`: optional list of highlight entries to show during recording on Android and iOS. Each entry includes optional `description`, `shape`, and optional `timing` (`startTimeMs`). On iOS, highlights require the AutoMobileSDK in-app bridge embedded in the target app; without it, iOS cannot draw an overlay into another app from the test runner and the highlight returns an actionable error.
    - Optional overrides for `targetBitrateKbps`, `fps`, `resolution`, `qualityPreset`, `format`,
      `maxDuration` (seconds, default 30, max 300), and `outputName`.
  - Returns: per-device recording metadata and any evictions.

Recording metadata now includes `highlights` entries with appearance/disappearance timestamps in seconds (millisecond precision).

## MCP Resources

- `automobile:video/latest` (metadata + blob)
- `automobile:video/archive` (metadata list)
- `automobile:video/archive/{recordingId}` (single video blob + metadata)

## Architecture

Introduce a `VideoRecorderService` with a pluggable backend interface:

```kotlin
interface VideoCaptureBackend {
  start(config): Promise<RecordingHandle>;
  stop(handle): Promise<RecordingResult>;
}
```

### Backend selection

Prefer FFmpeg/libav across macOS and Linux for best cross-platform performance and hardware acceleration:

- macOS: `ffmpeg` + VideoToolbox (H.264 hardware encode)
- Linux: `ffmpeg` + VAAPI/NVENC when available

Platform-specific capture sources:

- Android:
  - Physical devices: `adb exec-out screenrecord` (pipe to ffmpeg when transcoding or resizing).
  - Emulators: FFmpeg screen/window capture for higher throughput when ADB capture is slow.
- iOS (simulator only, macOS):
  - Prefer `simctl io recordVideo` for simulator-native capture.
  - Unscaled simulator recordings are finalized with an FFmpeg stream-copy remux from `.mov` to `.mp4`; this avoids a lossy re-encode and still applies `maxDuration` when a caller provides one.
  - Fallback to FFmpeg capture when available and needed for cross-platform parity.

## Storage and retention

- Archive directory: `~/.auto-mobile/video-archive`.
- Store recording metadata in SQLite (`~/.auto-mobile/auto-mobile.db`).
- Enforce `maxArchiveSizeMb` with LRU eviction (oldest first). Eviction only
  removes *other completed* recordings and only fires on stop or config change.
- Provide stable filenames (`recordingId` + timestamp).

### Time-based retention (TTL)

Size-based eviction alone lets sensitive recordings persist indefinitely while
the archive stays under `maxArchiveSizeMb`, and it never runs on a long-idle
daemon (it only fires on stop/config-change). A periodic **TTL sweep** (issue
[#4762](https://github.com/kaeawc/auto-mobile/issues/4762)) runs on an injected
timer and deletes completed/interrupted recordings whose age (relative to
`createdAt`) exceeds the retention window.

| Setting | Env var (either prefix) | Default |
| --- | --- | --- |
| Retention window | `AUTOMOBILE_VIDEO_RETENTION_DAYS` / `AUTO_MOBILE_VIDEO_RETENTION_DAYS` | `7` days (`0` disables the sweep) |
| Sweep interval | `AUTOMOBILE_VIDEO_RETENTION_SWEEP_MINUTES` / `AUTO_MOBILE_VIDEO_RETENTION_SWEEP_MINUTES` | `60` minutes |
| In-progress size-check interval | `AUTOMOBILE_VIDEO_INPROGRESS_CHECK_SECONDS` / `AUTO_MOBILE_VIDEO_INPROGRESS_CHECK_SECONDS` | `15` seconds |

Invalid or negative values fall back to the defaults (a warning is logged).

### In-progress size cap

A single long capture (iOS `simctl recordVideo` runs up to
`IOS_MAX_DURATION_SECONDS = 3600`) is not covered by archive eviction, which only
considers *other completed* recordings — so one uncapped recording can fill the
disk (a local DoS). Each live recording is monitored against the archive cap
(`maxArchiveSizeMb`); when its on-disk file reaches the cap the recording is
stopped (and finalized) rather than allowed to grow unbounded.

### Secure delete (known limitation)

Deletion (`deleteVideoRecording`, eviction, and the TTL sweep) uses
`fs.rm(recordingDir, { recursive: true, force: true })`. **This is not a secure
delete:** it unlinks the directory entry but does not overwrite the underlying
blocks, so screen-capture bytes — which may contain OTPs, credentials, or PII —
can remain recoverable from the raw storage device until the filesystem reuses
those blocks. An opt-in **"sensitive mode"** that overwrites recording bytes
before unlinking is intentionally left as a follow-up (see the flagged hook in
`deleteVideoRecording`) rather than paid as an unconditional cost on every
delete.

## Video recording configuration socket

- Unix socket: `~/.auto-mobile/video-recording.sock`.
- Supports `config/get` and `config/set` requests for live video recording defaults.

## Performance considerations

- Default to low-quality preset to reduce overhead.
- Hardware-accelerated encoding by default when supported.
- Avoid blocking tool calls; stop/start should be asynchronous and cancellable.

## Security and privacy

- Recording is opt-in only (explicit tool call or CLI flag).
- Sensitive metadata must be scrubbed from filenames.
- Recordings are stored owner-only (per-recording dir `0o700`, finalized file
  `0o600`; issue [#4750](https://github.com/kaeawc/auto-mobile/issues/4750)).
- Recordings are pruned on a time-based TTL (default 7 days) so sensitive content
  does not persist indefinitely; see [Time-based retention (TTL)](#time-based-retention-ttl).
- Deletion is a plain unlink, **not** a secure/overwrite delete; see
  [Secure delete (known limitation)](#secure-delete-known-limitation).
