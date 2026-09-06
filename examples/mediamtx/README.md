# MediaMTX example config

[MediaMTX](https://github.com/bluenviron/mediamtx) is the supported WHIP/WHEP
fanout for AutoMobile's WebRTC screen streaming: the daemon publishes a device's
screen to it over WHIP, and browsers watch over WHEP. It replaces the retired
hand-rolled reference coordination server — MediaMTX owns per-subscriber RTP
forwarding, keyframe recovery, and reconnect, so AutoMobile only has to publish.
The checked-in `mediamtx.yml` is a ready-to-run config for a local try-out; point
`AUTOMOBILE_WEBRTC_WHIP_ENDPOINT` at a per-stream WHIP URL it serves (see
[`mediamtx.yml`](./mediamtx.yml) for the URL scheme and the
[CI worker guide](../../docs/webrtc-streaming.md) for a full walkthrough).

## Watch a stream in a browser

MediaMTX ships a **built-in WHEP reader**, so no separate viewer needs to be
shipped or maintained. With the stock config running (`mediamtx ./mediamtx.yml`,
serving on `:8889`), open the stream name in a browser:

```
http://localhost:8889/<stream>
```

For example, a stream published to `http://localhost:8889/ci-run-42/whip` is
watchable at `http://localhost:8889/ci-run-42`. This is the "watch the stream in
a browser" path; MediaMTX also serves the raw WHEP endpoint at
`/<stream>/whep` for embedding in a custom page.

## Integration test

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

## Device capture coverage

`bun run test:integration:webrtc-device` runs the separate, opt-in device path:
real Android emulator or iOS Simulator capture → AutoMobile daemon socket → WHIP
→ MediaMTX → WHEP → headless Chrome. Set
`AUTOMOBILE_WEBRTC_DEVICE_INTEGRATION=1` and
`AUTOMOBILE_WEBRTC_DEVICE_PLATFORM=android` or `ios`; the selected device must
already be booted. The test launches the platform settings fixture, toggles its
appearance, and requires both browser frame progression and a changed rendered
sample.

In pull requests, maintainers apply the `webrtc` label to force both device
lanes. Otherwise they run only when the WebRTC pipeline, MediaMTX runner, daemon
socket lifecycle, or device integration test changes. Use the **WebRTC Device
Integration** workflow's manual dispatch with an `android`, `ios`, or `all`
platform selection for diagnosis.
