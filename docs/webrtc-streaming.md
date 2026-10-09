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
With `AUTOMOBILE_DAEMON_STREAM_AUTH=0`, lease ownership enforcement is advisory only and is not enforced.

## Viewers and device ownership

Watching never requires owning the device. A WebRTC or video-relay stream keeps
streaming when another session acquires, releases, or idle-releases the device; an
owner whose session loses the device is downgraded to a read-only viewer. A stream ends
only when its own session ends, the viewer disconnects, or the device goes away
(removed, restored from a snapshot, quarantined, or daemon shutdown), and the end is
reported with a typed reason. The capture is shared, so remaining viewers keep
receiving frames when other subscribers leave. Changing stream parameters and input
still require ownership.

## Troubleshooting

- `No WHIP endpoint configured`: set `AUTOMOBILE_WEBRTC_WHIP_ENDPOINT` or pass
  `whipEndpoint` in the start request.
- `401`: configure MediaMTX credentials and set
  `AUTOMOBILE_WEBRTC_WHIP_TOKEN`.
- Connected but black video: configure a reachable TURN server or MediaMTX ICE
  host.

### iOS Simulator highlights

On macOS, `highlight` draws over the Simulator through `screen-capture-helper`;
With a helper advertising `simulator-highlights`, Simulators do not need the
AutoMobile SDK in the target app. Older pinned helpers retain the SDK route until
a capable helper is released; a local helper can be selected using the override below. Physical iOS devices
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

Desktop subscriptions use the same read-only viewer policy as the video relay.
Each WebRTC lease records its subscription kind when admitted: viewers keep watching
through device ownership changes, while an owner losing ownership downgrades to a
viewer. This downgrade is one-way, even if that session later regains ownership;
renewal preserves the recorded kind. Any kind may release its own lease with `stop`,
or renew its live lease with a compatible `start`. A non-owner's leaseless `stop`
releases only that session's leases, preserving anonymous and other sessions' leases.
Capture stops when no leases remain. Viewers also allow `status`, `list`, and `await`.
`viewer_read_only` rejects changes to stream parameters or controls acting on others.

The device's current owner controls its streams: `stop`, with or without a lease,
stops the stream outright, releases the owner's leases, and ends every other lease
with `stopped_by_owner`. Viewers learn this on their next lease-carrying request.
An owner start with different parameters replaces the capture using bounded owner-stop
cleanup, ending other attached leases with `stopped_by_owner`. Compatible parameters
attach without restarting. Comparisons resolve environment defaults too.

Video relay `subscribe` and WebRTC `start`, including renewal, admit any live,
non-releasing device session to any device. The owning session attaches as `owner`;
other device sessions attach read-only as `viewer`, including on another session's
device. Missing, unknown, expired, releasing and registration-only observer sessions
remain rejected. Viewers cannot change an owner's capture or control: WebRTC joins
keep the existing capture configuration. A fresh WebRTC viewer start ignores all
capture overrides and uses environment defaults if it starts the capture. Viewer
lease renewals must remain compatible. The video relay ignores viewer hints and
size while the device has an owner; a first owner join replaces viewer-created
hints and size with its supplied values or defaults. Owner-less relay hints retain
the existing last-supplied semantics.

Either kind ends when its session ends (`session_ended`), the device is removed
(`device_removed`) or quarantined (`identity_quarantined`), or the daemon shuts down
(`daemon_shutdown`). VM restore ends the captured incarnation as `device_restored`.
This socket is request/response only: the next `status`, `await`, or `stop` carrying
an ended lease reports its `reason` and `subscriptionKind`. Ended leases are retained
for one lease TTL, up to 256 entries; a later `start` can re-subscribe with a new lease.
The optional response fields `subscriptionKind`, `reason`, and `errorCode` are additive
and can be ignored by older clients. Auth disabled and legacy authenticators without
an ownership resolver retain the previous stop and attach semantics.

Observation-stream, telemetry-push, failures-push, and performance-push subscribe commands require a valid `sessionUuid` when stream authentication is enabled. Register one with `daemon/registerSession` (or acquire a device session) before subscribing. Older desktop apps are rejected at subscribe until they register and send their session UUID. `AUTOMOBILE_DAEMON_STREAM_AUTH=0` retains the existing opt-out behavior. Registration-only sessions are admitted only on observation and push paths; device-scoped observation requests retain their existing ownership checks.
