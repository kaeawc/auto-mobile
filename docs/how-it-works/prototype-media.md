# Prototype media runtime placement

Where video and audio playback for prototypes lives and which formats each simulator or emulator
can play. The spike measurements behind these rules (APK size, decode matrices, audio clock
behavior, what was not measured) are in the
[media runtime placement devlog entry](../devlog/2026-11-21-prototype-media-runtime-placement-spike.md).

## Placement

- CtrlProxy links core `media3-exoplayer` only: no HLS, DASH, `session`, or `ui` artifacts. Inline
  overlay video is allowed.
- Anything heavier (HLS/DASH, MediaSession, notification controls, caching) belongs in ProtoViewer
  or a disposable app, never in CtrlProxy.
- `media3-ui-compose` is optional in CtrlProxy. Link it only if the overlay is rendered through
  `PlayerSurface`.

## Host warnings per platform (input for `platformNotes`)

- Android: WebM and MKV containers, VP9 and AV1 depend on the device; AV1 on emulators is software
  decoded. Use MP4 with H.264 and AAC for portable fixtures.
- iOS: reject WebM, MKV and AV1 at validation; prefer MP4 with H.264 or HEVC and AAC. Opus plays as
  an Ogg audio file; Opus inside video containers is untested (WebM/MKV are rejected).
- Both: subtitles are rendered by the player library, not platform codecs.
- Both: do not assert real-time playback progress on emulators. The emulator `AudioTrack` playback
  head jumps to the end of the buffer, so CI asserts decoder output and player state, not
  wall-clock `currentPosition` progress.
