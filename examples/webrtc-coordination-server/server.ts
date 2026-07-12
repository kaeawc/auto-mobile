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
  const trimmed = raw.trim();
  // Accept the same JSON shape the publisher config does, so credentialed TURN
  // servers survive round-tripping to the browser viewer. werift's RTCIceServer
  // takes a single `urls` string, so expand array `urls` into one server per URL.
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as Array<{ urls?: unknown; username?: string; credential?: string }>;
    const servers: RTCIceServer[] = [];
    for (const entry of parsed) {
      const { username, credential } = entry ?? {};
      const urls = entry?.urls;
      if (typeof urls === "string") {
        servers.push({ urls, username, credential });
      } else if (Array.isArray(urls)) {
        for (const url of urls) {
          if (typeof url === "string") {
            servers.push({ urls: url, username, credential });
          }
        }
      }
    }
    return servers;
  }
  return trimmed
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
