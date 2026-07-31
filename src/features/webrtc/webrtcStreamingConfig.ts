import { ActionableError } from "../../models";
import type { RTCIceServer } from "werift";
import { h264MacroblocksPerFrame, WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME } from "./h264Level";
import { SIMULATOR_FPS_MAX, SIMULATOR_FPS_MIN } from "../screen-stream/IOSScreenCaptureHelper";

/**
 * Safe range for the iOS Simulator WebRTC capture rate. These mirror the
 * screen-capture helper's own bounds so a configured value can never be
 * rejected downstream by the helper's argv validation.
 */
export const WEBRTC_IOS_SIMULATOR_FPS_MIN = SIMULATOR_FPS_MIN;
export const WEBRTC_IOS_SIMULATOR_FPS_MAX = SIMULATOR_FPS_MAX;
/**
 * Conservative default for an interactive WebRTC feed, deliberately separate
 * from `SIMULATOR_FPS_DEFAULT` (which is tuned for one-shot MCP observation,
 * where 5 fps is plenty). 15 fps is smooth enough to follow a gesture or an
 * animation while leaving headroom on a hosted macOS runner, where the Simulator
 * processes and VideoToolbox share one CPU/encoder budget and `-allow_sw` may
 * put the encoder in software. 30/60 leaves no such margin. Raise it per-worker
 * with `AUTOMOBILE_WEBRTC_IOS_SIMULATOR_FPS` once the hosted-lane decode and
 * first-frame timings show the host can afford it.
 */
export const WEBRTC_IOS_SIMULATOR_FPS_DEFAULT = 15;

/**
 * Safe range for the Android video-server capture rate, forwarded to the
 * persistent encoder as `--fps`. Kept generous so any reasonable interactive
 * rate is accepted; the device encoder clamps beyond its own capability.
 */
export const WEBRTC_ANDROID_FPS_MIN = 1;
export const WEBRTC_ANDROID_FPS_MAX = 60;
/**
 * Default Android capture rate. 30fps is smooth for UI automation (mostly static
 * frames with occasional transitions) while roughly halving MediaCodec encode
 * load and bitrate versus the old preset-locked 60fps. Raise it per-worker with
 * `AUTOMOBILE_WEBRTC_ANDROID_FPS` when a scenario needs it.
 */
export const WEBRTC_ANDROID_FPS_DEFAULT = 30;

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
   * Frame rate requested from the iOS Simulator screen-capture helper, in
   * `[WEBRTC_IOS_SIMULATOR_FPS_MIN, WEBRTC_IOS_SIMULATOR_FPS_MAX]`. Android
   * ignores it; physical iOS captures at its own device rate but still takes
   * its declared encoder input rate and GOP length from it.
   */
  iosSimulatorFps: number;
  /**
   * Frame rate forwarded to the Android video-server as `--fps`, in
   * `[WEBRTC_ANDROID_FPS_MIN, WEBRTC_ANDROID_FPS_MAX]`. iOS ignores it.
   */
  androidFps: number;
  /**
   * Use trickle ICE: publish the WHIP offer immediately and send local
   * candidates incrementally (HTTP PATCH) instead of blocking on ICE gathering.
   * Opt-in — the ingest server must support the WHIP PATCH trickle extension.
   */
  trickleIce: boolean;
  /** Add an optional audio track alongside video. Defaults to false. */
  audioEnabled: boolean;
}

export interface WebRtcStreamingOverrides {
  whipEndpoint?: string;
  bearerToken?: string;
  iceServers?: RTCIceServer[];
  bitrateKbps?: number;
  size?: { width: number; height: number };
  iosSimulatorFps?: number;
  androidFps?: number;
  trickleIce?: boolean;
  audioEnabled?: boolean;
}

/** Environment variable names read for default configuration. */
export const WEBRTC_ENV = {
  WHIP_ENDPOINT: "AUTOMOBILE_WEBRTC_WHIP_ENDPOINT",
  WHIP_TOKEN: "AUTOMOBILE_WEBRTC_WHIP_TOKEN",
  ICE_SERVERS: "AUTOMOBILE_WEBRTC_ICE_SERVERS",
  BITRATE_KBPS: "AUTOMOBILE_WEBRTC_BITRATE_KBPS",
  MAX_SIZE: "AUTOMOBILE_WEBRTC_MAX_SIZE",
  IOS_SIMULATOR_FPS: "AUTOMOBILE_WEBRTC_IOS_SIMULATOR_FPS",
  ANDROID_FPS: "AUTOMOBILE_WEBRTC_ANDROID_FPS",
  TRICKLE_ICE: "AUTOMOBILE_WEBRTC_TRICKLE_ICE",
  AUDIO: "AUTOMOBILE_WEBRTC_AUDIO",
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
  return validateSize({ width: Number(match[1]), height: Number(match[2]) });
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
  const bitrateKbps = overrides.bitrateKbps === undefined
    ? parseBitrate(env[WEBRTC_ENV.BITRATE_KBPS])
    : validateBitrate(overrides.bitrateKbps);
  const size = overrides.size === undefined
    ? parseSize(env[WEBRTC_ENV.MAX_SIZE])
    : validateSize(overrides.size);
  const iosSimulatorFps = overrides.iosSimulatorFps === undefined
    ? parseIosSimulatorFps(env[WEBRTC_ENV.IOS_SIMULATOR_FPS]) ?? WEBRTC_IOS_SIMULATOR_FPS_DEFAULT
    : validateIosSimulatorFps(overrides.iosSimulatorFps);
  const androidFps = overrides.androidFps === undefined
    ? parseAndroidFps(env[WEBRTC_ENV.ANDROID_FPS]) ?? WEBRTC_ANDROID_FPS_DEFAULT
    : validateAndroidFps(overrides.androidFps);
  const trickleIce = overrides.trickleIce ?? parseBooleanFlag(env[WEBRTC_ENV.TRICKLE_ICE]);
  const audioEnabled = overrides.audioEnabled ?? parseBooleanFlag(env[WEBRTC_ENV.AUDIO]);

  return {
    whipEndpoint: validateWhipEndpoint(whipEndpoint),
    bearerToken: overrides.bearerToken ?? env[WEBRTC_ENV.WHIP_TOKEN] ?? undefined,
    iceServers,
    bitrateKbps,
    size,
    iosSimulatorFps,
    androidFps,
    trickleIce,
    audioEnabled,
  };
}

function parseIosSimulatorFps(raw: string | undefined): number | undefined {
  if (!raw || !raw.trim()) {
    return undefined;
  }
  return validateIosSimulatorFps(Number(raw.trim()), raw.trim());
}

function validateIosSimulatorFps(value: number, raw: string = String(value)): number {
  if (
    !Number.isInteger(value) ||
    value < WEBRTC_IOS_SIMULATOR_FPS_MIN ||
    value > WEBRTC_IOS_SIMULATOR_FPS_MAX
  ) {
    throw new ActionableError(
      `Invalid iOS Simulator capture fps "${raw}"; expected an integer in [${WEBRTC_IOS_SIMULATOR_FPS_MIN}, ${WEBRTC_IOS_SIMULATOR_FPS_MAX}]. Set ${WEBRTC_ENV.IOS_SIMULATOR_FPS} or pass iosSimulatorFps.`
    );
  }
  return value;
}

function parseAndroidFps(raw: string | undefined): number | undefined {
  if (!raw || !raw.trim()) {
    return undefined;
  }
  return validateAndroidFps(Number(raw.trim()), raw.trim());
}

function validateAndroidFps(value: number, raw: string = String(value)): number {
  if (
    !Number.isInteger(value) ||
    value < WEBRTC_ANDROID_FPS_MIN ||
    value > WEBRTC_ANDROID_FPS_MAX
  ) {
    throw new ActionableError(
      `Invalid Android capture fps "${raw}"; expected an integer in [${WEBRTC_ANDROID_FPS_MIN}, ${WEBRTC_ANDROID_FPS_MAX}]. Set ${WEBRTC_ENV.ANDROID_FPS} or pass androidFps.`
    );
  }
  return value;
}

function validateBitrate(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ActionableError(`Invalid bitrate "${value}"; expected a positive number of kbps.`);
  }
  return Math.round(value);
}

function validateSize(size: { width: number; height: number }): { width: number; height: number } {
  const { width, height } = size;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width % 2 !== 0 ||
    height % 2 !== 0 ||
    h264MacroblocksPerFrame(width, height) > WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME
  ) {
    throw new ActionableError(
      `Invalid size "${width}x${height}"; width and height must be positive even integers within the H.264 Level 4.2 frame limit.`
    );
  }
  return { width, height };
}

function validateWhipEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new ActionableError(`Invalid WHIP endpoint "${trimmed}"; expected an absolute http(s) URL.`);
  }
  return trimmed;
}
