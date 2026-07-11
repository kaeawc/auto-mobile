#!/usr/bin/env bun
import { HttpCoordinationServer } from "./httpServer";
import type { RTCIceServer } from "werift";

/**
 * Entry point for the reference coordination server.
 *
 *   PORT                          listen port (default 8080)
 *   AUTOMOBILE_WEBRTC_INGEST_TOKEN  optional bearer token required on WHIP ingest
 *   AUTOMOBILE_WEBRTC_ICE_SERVERS   comma-separated STUN/TURN URLs advertised to viewers
 */
function parseIceServers(raw: string | undefined): RTCIceServer[] | undefined {
  if (!raw || !raw.trim()) {
    return undefined;
  }
  return raw
    .split(",")
    .map(url => url.trim())
    .filter(Boolean)
    .map(url => ({ urls: url }));
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);
  const server = new HttpCoordinationServer({
    ingestToken: process.env.AUTOMOBILE_WEBRTC_INGEST_TOKEN,
    iceServers: parseIceServers(process.env.AUTOMOBILE_WEBRTC_ICE_SERVERS),
  });

  const boundPort = await server.listen(port);

  console.log(`WebRTC coordination server listening on http://localhost:${boundPort}`);

  console.log(`  WHIP ingest:   POST http://localhost:${boundPort}/whip`);

  console.log(`  Reconnect API: GET  http://localhost:${boundPort}/api/streams`);

  console.log(`  Viewer:             http://localhost:${boundPort}/`);

  const shutdown = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
