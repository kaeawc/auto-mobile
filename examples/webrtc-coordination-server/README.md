# AutoMobile WebRTC Coordination Server (reference)

A minimal, self-contained **WHIP ingest → WHEP egress** coordination server for
AutoMobile's WebRTC screen streaming. An AutoMobile daemon (typically on a CI
worker) **publishes** a device's screen, plus optional audio, here over WHIP;
browsers **subscribe** over WHEP and watch it live. A small REST "reconnect API"
lets a frontend discover active streams and reconnect.

```
 Android device                AutoMobile daemon              This server                 Browser
 ┌────────────┐  screenrecord  ┌─────────────────┐   WHIP    ┌───────────────┐   WHEP   ┌─────────┐
 │  screen    │──H.264 (adb)──▶│ WebRtcPublisher │──(HTTP)──▶│  ingest  ──┐  │◀────────▶│ <video> │
 └────────────┘                └─────────────────┘  offer/   │            ▼  │  offer/  └─────────┘
                                                     answer   │  forward RTP  │  answer
                                                              │            │  │
                                                              │  egress ◀──┘  │
                                                              └───────────────┘
                                                                    ▲
                                                          GET /api/streams (reconnect API)
```

> ⚠️ Reference quality only — single process, in-memory, no persistence or
> horizontal scaling. For production, point AutoMobile at a hardened SFU that
> speaks WHIP/WHEP (MediaMTX, LiveKit, Janus, Cloudflare Stream). The AutoMobile
> publisher side is unchanged; only the coordination server differs.

## Run

```bash
cd examples/webrtc-coordination-server
bun install          # installs werift
PORT=8080 bun run start
```

Then open <http://localhost:8080/> in a browser to see the viewer.

Environment variables:

| Variable | Purpose |
|----------|---------|
| `PORT` | Listen port (default `8080`) |
| `AUTOMOBILE_WEBRTC_INGEST_TOKEN` | If set, WHIP ingest requires `Authorization: Bearer <token>` |
| `AUTOMOBILE_WEBRTC_ICE_SERVERS` | Comma-separated STUN/TURN URLs advertised to viewers |

## Point AutoMobile at it

On the CI worker running the AutoMobile daemon:

```bash
export AUTOMOBILE_WEBRTC_WHIP_ENDPOINT="https://your-host:8080/whip"
# optional:
export AUTOMOBILE_WEBRTC_WHIP_TOKEN="<same as AUTOMOBILE_WEBRTC_INGEST_TOKEN>"
export AUTOMOBILE_WEBRTC_ICE_SERVERS="stun:stun.l.google.com:19302"
```

Start a stream via the daemon's `webrtc-stream.sock` control socket (see the
[design doc](../../docs/design-docs/mcp/observe/webrtc-streaming.md) and
[CI worker guide](../../docs/webrtc-streaming-ci-worker.md)):

```bash
echo '{"action":"start","deviceId":"emulator-5554","streamId":"ci-run-42"}' \
  | nc -U ~/.auto-mobile/webrtc-stream.sock
```

## HTTP API

| Method & path | Purpose |
|---------------|---------|
| `POST /whip[?streamId=]` | WHIP ingest — `Content-Type: application/sdp`; returns `201` + SDP answer + `Location: /whip/{streamId}` + `ETag` |
| `PATCH /whip/{streamId}` | WHIP Trickle ICE — `Content-Type: application/trickle-ice-sdpfrag` and `If-Match: <ETag>`; returns `204` for candidates or `422` for unsupported ICE restart |
| `DELETE /whip/{streamId}` | Terminate an ingest session |
| `POST /whep/{streamId}` | WHEP subscribe — body is the viewer SDP offer; returns `201` + SDP answer + `Location: /whep/{streamId}/{subscriberId}` |
| `DELETE /whep/{streamId}/{subscriberId}` | Terminate a subscriber |
| `GET /api/streams` | **Reconnect API** — `{ streams: StreamDescriptor[] }` |
| `GET /api/streams/{streamId}` | Reconnect API — one `StreamDescriptor` |
| `GET /` | Browser viewer |

### `StreamDescriptor` (reconnect payload)

```jsonc
{
  "streamId": "ci-run-42",
  "state": "live",              // "connecting" | "live" | "ended"
  "subscriberCount": 1,
  "createdAt": "2026-07-11T00:00:00.000Z",
  "whepUrl": "/whep/ci-run-42", // POST an SDP offer here to (re)connect
  "iceServers": [{ "urls": "stun:stun.l.google.com:19302" }],
  "framesForwarded": 512,
  "audio": true,
  "audioPacketsForwarded": 2400
}
```

A frontend reconnects by polling `GET /api/streams`, and for a chosen stream
POSTing a fresh SDP offer to its `whepUrl` using the advertised `iceServers`.
The viewer in `viewer.html` does exactly this, including automatic retry when
the peer connection drops.

## Files

- `coordinationServer.ts` — the SFU core (WHIP ingest, RTP forwarding, WHEP egress)
- `httpServer.ts` — HTTP/WHIP/WHEP routing + reconnect API + viewer serving
- `server.ts` — entry point
- `viewer.html` — self-contained browser viewer with reconnect
