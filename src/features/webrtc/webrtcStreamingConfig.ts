import { ActionableError } from "../../models";
import type { RTCIceServer } from "werift";

/**
 * WebRTC streaming configuration. On a CI worker this is typically supplied
 * once via environment variables so `webrtcStream` can be started with no
 * per-call arguments; individual tool calls may override any field.
 */
export interface WebRtcStreamingConfig {
  /** WHIP ingest endpoint on the coordination server. */
  whipEndpoint: string;
  /** Optional bearer token for the ingest endpoint. */
  bearerToken?: string;
  /** ICE servers (STUN/TURN) for NAT traversal. */
  iceServers: RTCIceServer[];
  /** Target encoder bitrate in kbps. */
  bitrateKbps?: number;
  /** Optional capture downscale. */
  size?: { width: number; height: number };
  /**
   * Use trickle ICE: publish the WHIP offer immediately and send local
   * candidates incrementally (HTTP PATCH) instead of blocking on ICE gathering.
   * Opt-in — the ingest server must support the WHIP PATCH trickle extension.
   */
  trickleIce: boolean;
}

export interface WebRtcStreamingOverrides {
  whipEndpoint?: string;
  bearerToken?: string;
  iceServers?: RTCIceServer[];
  bitrateKbps?: number;
  size?: { width: number; height: number };
  trickleIce?: boolean;
}

/** Environment variable names read for default configuration. */
export const WEBRTC_ENV = {
  WHIP_ENDPOINT: "AUTOMOBILE_WEBRTC_WHIP_ENDPOINT",
  WHIP_TOKEN: "AUTOMOBILE_WEBRTC_WHIP_TOKEN",
  ICE_SERVERS: "AUTOMOBILE_WEBRTC_ICE_SERVERS",
  BITRATE_KBPS: "AUTOMOBILE_WEBRTC_BITRATE_KBPS",
  MAX_SIZE: "AUTOMOBILE_WEBRTC_MAX_SIZE",
  TRICKLE_ICE: "AUTOMOBILE_WEBRTC_TRICKLE_ICE",
} as const;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

/**
 * Parse ICE servers from an environment string. Accepts either a JSON array of
 * `RTCIceServer` objects, or a comma-separated list of URLs
 * (e.g. `stun:stun.l.google.com:19302,turn:turn.example.com:3478`).
 */
export function parseIceServers(raw: string | undefined): RTCIceServer[] | undefined {
  if (!raw || !raw.trim()) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new ActionableError(`Invalid JSON in ${WEBRTC_ENV.ICE_SERVERS}.`);
    }
    if (!Array.isArray(parsed)) {
      throw new ActionableError(`${WEBRTC_ENV.ICE_SERVERS} JSON must be an array of { urls } objects.`);
    }
    // werift's RTCIceServer takes a single `urls` string, but the standard
    // RTCIceServer allows `urls` to be a string OR an array of strings (common
    // for TURN with UDP + TLS variants). Normalize each array entry into one
    // werift server per URL, sharing username/credential.
    const servers: RTCIceServer[] = [];
    for (const entry of parsed as Array<{ urls?: unknown; username?: string; credential?: string }>) {
      const { username, credential } = entry ?? {};
      if (typeof entry?.urls === "string") {
        servers.push({ urls: entry.urls, username, credential });
      } else if (Array.isArray(entry?.urls) && entry.urls.every(url => typeof url === "string")) {
        for (const url of entry.urls as string[]) {
          servers.push({ urls: url, username, credential });
        }
      } else {
        throw new ActionableError(
          `${WEBRTC_ENV.ICE_SERVERS} JSON entries must have a string or string[] "urls".`
        );
      }
    }
    return servers;
  }
  return trimmed
    .split(",")
    .map(url => url.trim())
    .filter(url => url.length > 0)
    .map(url => ({ urls: url }));
}

/** Parse a `WIDTHxHEIGHT` string (e.g. `1280x720`). */
export function parseSize(raw: string | undefined): { width: number; height: number } | undefined {
  if (!raw || !raw.trim()) {
    return undefined;
  }
  const match = /^(\d+)\s*x\s*(\d+)$/i.exec(raw.trim());
  if (!match) {
    throw new ActionableError(`Invalid size "${raw}"; expected WIDTHxHEIGHT (e.g. 1280x720).`);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** Parse a boolean env flag (`1/true/yes/on`, case-insensitive). */
export function parseBooleanFlag(raw: string | undefined): boolean {
  if (!raw) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function parseBitrate(raw: string | undefined): number | undefined {
  if (!raw || !raw.trim()) {
    return undefined;
  }
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new ActionableError(`Invalid bitrate "${raw}"; expected a positive number of kbps.`);
  }
  return Math.round(value);
}

/**
 * Resolve the effective streaming config by layering per-call overrides over
 * environment defaults. Throws an {@link ActionableError} when no WHIP endpoint
 * is configured, since the publisher cannot start without one.
 */
export function resolveWebRtcStreamingConfig(
  overrides: WebRtcStreamingOverrides = {},
  env: NodeJS.ProcessEnv = process.env
): WebRtcStreamingConfig {
  const whipEndpoint = overrides.whipEndpoint ?? env[WEBRTC_ENV.WHIP_ENDPOINT];
  if (!whipEndpoint || !whipEndpoint.trim()) {
    throw new ActionableError(
      `No WHIP endpoint configured. Set ${WEBRTC_ENV.WHIP_ENDPOINT} or pass whipEndpoint.`
    );
  }

  const iceServers =
    overrides.iceServers ?? parseIceServers(env[WEBRTC_ENV.ICE_SERVERS]) ?? DEFAULT_ICE_SERVERS;
  const bitrateKbps = overrides.bitrateKbps ?? parseBitrate(env[WEBRTC_ENV.BITRATE_KBPS]);
  const size = overrides.size ?? parseSize(env[WEBRTC_ENV.MAX_SIZE]);
  const trickleIce = overrides.trickleIce ?? parseBooleanFlag(env[WEBRTC_ENV.TRICKLE_ICE]);

  return {
    whipEndpoint: whipEndpoint.trim(),
    bearerToken: overrides.bearerToken ?? env[WEBRTC_ENV.WHIP_TOKEN] ?? undefined,
    iceServers,
    bitrateKbps,
    size,
    trickleIce,
  };
}
