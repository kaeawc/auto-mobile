# MediaMTX integration test

The checked-in `mediamtx.yml` is exercised by an opt-in integration test. It
uses the actual AutoMobile `WebRtcPublisher` to ingest a synthetic, valid H.264
stream over WHIP, then opens MediaMTX's built-in WHEP reader in headless Chrome
and requires decoded video frames.

Run it from the repository root:

```bash
bun run test:integration:webrtc-mediamtx
```

The runner downloads the pinned official MediaMTX v1.19.2 binary into
`scratch/mediamtx`, verifies the release SHA-256 before extraction, and starts
it with this configuration. The download is cached. It requires `curl`, `tar`,
`ffmpeg` with `libx264`, and Google Chrome. On Linux, set
`AUTOMOBILE_CHROME_BINARY` if Chrome is not installed at a standard path.

To use a pre-downloaded binary instead, point the runner at it:

```bash
AUTOMOBILE_MEDIAMTX_BINARY=/path/to/mediamtx \
  bun run test:integration:webrtc-mediamtx
```

The test uses localhost-only MediaMTX authentication from `mediamtx.yml` and
temporarily binds the WebRTC HTTP listener to port 8889. Stop a conflicting
local MediaMTX process before running it. The normal `bun test` suite leaves
this test skipped; it does not require MediaMTX, FFmpeg, or Chrome.
