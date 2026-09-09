# WebRTC Streaming

Stream the Android device or iOS simulator driven by an AutoMobile daemon to a
WHIP server such as [MediaMTX](https://github.com/bluenviron/mediamtx), then
watch it through WHEP in a browser.

```text
CI worker → WHIP ingest → MediaMTX → WHEP browser viewer
```

## Configure the worker

Start the daemon with a booted Android device or iOS simulator, then set a
unique WHIP path for each CI job:

```bash
export AUTOMOBILE_WEBRTC_WHIP_ENDPOINT="https://mediamtx.example.com:8889/$CI_JOB_ID/whip"
# Optional for authenticated or NAT-restricted deployments:
export AUTOMOBILE_WEBRTC_WHIP_TOKEN="<user>:<pass>"
export AUTOMOBILE_WEBRTC_ICE_SERVERS='[{"urls":"turn:turn.example.com:3478","username":"user","credential":"secret"}]'
```

MediaMTX must expose its WHIP/WHEP listener and reachable ICE candidates. For
containerized or firewalled deployments, expose its WebRTC UDP port too.

## Start, watch, and stop

The daemon accepts newline-delimited JSON on
`~/.auto-mobile/webrtc-stream.sock`:

```bash
SESSION_UUID="<sessionUuid returned by the MCP getAndroid or getApple tool>"
DEVICE_ID="<device id returned by the same tool>"
PLATFORM="android" # Use "ios" for an iOS Simulator.
STREAM_ID="$CI_JOB_ID"
WHIP="https://mediamtx.example.com:8889/$CI_JOB_ID/whip"
START_RESPONSE="$(
  jq -nc \
    --arg sessionUuid "$SESSION_UUID" \
    --arg deviceId "$DEVICE_ID" \
    --arg platform "$PLATFORM" \
    --arg streamId "$STREAM_ID" \
    --arg whipEndpoint "$WHIP" \
    '{action:"start",$sessionUuid,$deviceId,$platform,$streamId,$whipEndpoint}' \
    | nc -U ~/.auto-mobile/webrtc-stream.sock
)"
LEASE_ID="$(jq -er '.stream.lease.id' <<<"$START_RESPONSE")"

# Watch: https://mediamtx.example.com:8889/$CI_JOB_ID
# Send this status request at least once every 60 seconds while the job runs;
# carrying leaseId renews the stream lease.
jq -nc \
  --arg sessionUuid "$SESSION_UUID" \
  --arg streamId "$STREAM_ID" \
  --arg leaseId "$LEASE_ID" \
  '{action:"status",$sessionUuid,$streamId,$leaseId}' \
  | nc -U ~/.auto-mobile/webrtc-stream.sock

jq -nc \
  --arg sessionUuid "$SESSION_UUID" \
  --arg streamId "$STREAM_ID" \
  --arg leaseId "$LEASE_ID" \
  '{action:"stop",$sessionUuid,$streamId,$leaseId}' \
  | nc -U ~/.auto-mobile/webrtc-stream.sock
```

Acquire a fresh daemon session with the public MCP `getAndroid` or `getApple`
tool before opening the socket; every request must carry that tool's
`sessionUuid`. The example always includes `deviceId` and `platform` so the iOS
path cannot silently fall back to Android. The stream reconnects after transient
network failures; browser viewers may need to reconnect too.

## Troubleshooting

- `No WHIP endpoint configured`: set `AUTOMOBILE_WEBRTC_WHIP_ENDPOINT` or pass
  `whipEndpoint` in the start request.
- `401`: configure MediaMTX credentials and set
  `AUTOMOBILE_WEBRTC_WHIP_TOKEN`.
- Connected but black video: configure a reachable TURN server or MediaMTX ICE
  host.

### iOS Simulator highlights

On macOS, `highlight` draws over the Simulator through `screen-capture-helper`;
Simulators do not need the AutoMobile SDK in the target app. Physical iOS devices
continue to use the SDK overlay. The host helper needs Screen Recording and
Accessibility access in System Settings → Privacy & Security. The Simulator window
must be visible. For capture of highlights, keep the window fully on one monitor.

Highlights draw a red hand-drawn circle using Android’s irregular arcs, varying
stroke width, and 1.2-second draw/hold/fade animation. Circle bounds use device
coordinates, with `bounds.sourceWidth` and `bounds.sourceHeight` describing their
source coordinate space. Selector-based highlights obtain these dimensions from
the hierarchy automatically. The helper reads the Simulator's accessibility
display bounds to exclude its toolbar and bezel when positioning circles. Box, path, color, and stroke-style options are not supported.

While a highlight is visible, ScreenCaptureKit captures only the selected Simulator
and the helper's overlay windows, cropped to the Simulator window. The same capture
path feeds raw frames and H.264 streams. Separate device screenshots do not include
the host overlay. Outside highlights, capture uses its independent-window filter.
The overlay host stays alive until its parent daemon exits because ScreenCaptureKit
retains connections to applications whose windows have appeared in a stream.

For a local development build, build `ios/screen-capture` with SwiftPM and set
`AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER` to the absolute path of its
`screen-capture-helper` executable when starting AutoMobile. Both capture and
highlighting must use this build; older released helpers do not support the overlay
command. Rebuilt or unsigned executables may require renewed macOS privacy approval.
