# CI screen streaming

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
WHIP="https://mediamtx.example.com:8889/$CI_JOB_ID/whip"
echo '{"action":"start","streamId":"'"$CI_JOB_ID"'","whipEndpoint":"'"$WHIP"'"}' \
  | nc -U ~/.auto-mobile/webrtc-stream.sock

# Watch: https://mediamtx.example.com:8889/$CI_JOB_ID
echo '{"action":"status","streamId":"'"$CI_JOB_ID"'"}' \
  | nc -U ~/.auto-mobile/webrtc-stream.sock

echo '{"action":"stop","streamId":"'"$CI_JOB_ID"'"}' \
  | nc -U ~/.auto-mobile/webrtc-stream.sock
```

Pass `deviceId` when more than one device is connected. The stream reconnects
after transient network failures; browser viewers may need to reconnect too.

## Troubleshooting

- `No WHIP endpoint configured`: set `AUTOMOBILE_WEBRTC_WHIP_ENDPOINT` or pass
  `whipEndpoint` in the start request.
- `401`: configure MediaMTX credentials and set
  `AUTOMOBILE_WEBRTC_WHIP_TOKEN`.
- Connected but black video: configure a reachable TURN server or MediaMTX ICE
  host.
