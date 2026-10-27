import type { H264CaptureSource } from "../features/webrtc/H264CaptureSource";
import { ScreenRecordingPermissionError } from "../features/webrtc/IosH264Source";
import { type DeviceCaptureRegistry } from "../features/webrtc/deviceCaptureRegistry";
import type { BootedDevice } from "../models";
import { errorMessage } from "../utils/describeUnknownError";
import { type ObserverReleaseSource } from "./observerReleaseBroadcast";
import { type StreamDeviceLifecycleEvents } from "./streamDeviceLifecycleEvents";
import { streamAuthRefusalFields } from "./streamSocketAuth";
import {
  type StreamSubscriptionIdentity,
  type StreamSubscriptionKind,
} from "./wire/streamSubscriptionPolicy";
import type { CaptureHints, CaptureSourceFactory } from "./videoStream/captureTypes";
import type {
  VideoStreamSocketRequest,
  VideoStreamSocketResponse,
} from "./wire/videoStreamSocketTypes";

export function tracksConsumers(
  source: H264CaptureSource | null,
): source is H264CaptureSource & { setHasConsumers(hasConsumers: boolean): void } {
  return (
    source !== null && "setHasConsumers" in source && typeof source.setHasConsumers === "function"
  );
}

export interface VideoStreamSocketServerDependencies {
  createCaptureSource: CaptureSourceFactory;
  /** Share across transports by injection; omitted registries are local to this server. */
  captureRegistry?: DeviceCaptureRegistry;
  resolveDevice: (deviceId?: string, platform?: "android" | "ios") => Promise<BootedDevice>;
  /** Monotonic microseconds, used for packet presentation timestamps. */
  nowUs: () => bigint;
  ownershipChanges?: () => DeviceOwnershipChanges | null;
  deviceLifecycle?: () => StreamDeviceLifecycleEvents | null;
  /** Also covers device-less viewer sessions, whose release changes no device owner. */
  sessionReleases?: { subscribe(callback: (sessionId: string) => void): () => void };
  /** Released or expired observer registrations, which change no device owner (#11076). */
  observerReleases?: ObserverReleaseSource;
  /** Maximum time a subscriber may wait for outbound drain. */
  outboundStallTimeoutMs?: number;
}

/** The only session-manager event surface the relay needs. */
export interface DeviceOwnershipChanges {
  onDeviceOwnershipChange(callback: (deviceId: string) => void): () => void;
}

/** Completes the FUNNEL 2 refusal: "Refusing `<purpose>` on device '<serial>'". */
export const VIDEO_STREAM_PURPOSE = "to stream video";

export const SUPPORTED_QUALITIES = new Set(["low", "medium", "high"]);
// The relay resolves the device only after this validation, so it bounds fps to the range every
// capture backend can honor rather than a per-platform limit. The iOS Simulator helper is the
// tightest at [5, 60] (SIMULATOR_FPS_MIN/MAX); the Android video-server accepts any positive
// rate, so [5, 60] is the safe universal window — a hint outside it would pass here and then throw
// at iOS capture startup.
export const MIN_FPS_HINT = 5;
export const MAX_FPS_HINT = 60;
// A generous encoder ceiling (~1 Gbps) that still leaves headroom below Number.MAX_SAFE_INTEGER
// after the kbps→bps ×1000 conversion at the capture-options boundary, so a huge-but-finite hint
// cannot silently lose integer precision downstream.
export const MAX_BITRATE_KBPS = 1_000_000;

// Covers brief viewer reconnects without keeping an abandoned encoder alive for long.
export const CAPTURE_IDLE_GRACE_MS = 3_000;
export const RECONFIGURE_DEBOUNCE_MS = 200;

// Same bound the WebRTC server puts on its close (WEBRTC_SOCKET_CLOSE_TIMEOUT_MS).
export const VIDEO_STREAM_SOCKET_CLOSE_TIMEOUT_MS = 5_000;

export function subscriberMaySetCaptureHints(
  kind: StreamSubscriptionKind,
  identity?: StreamSubscriptionIdentity,
): boolean {
  return kind !== "viewer" || identity?.hasDeviceOwner === false;
}

export function sameHints(left: CaptureHints, right: CaptureHints): boolean {
  return (
    left.quality === right.quality &&
    left.fps === right.fps &&
    left.bitrateKbps === right.bitrateKbps &&
    left.size?.width === right.size?.width &&
    left.size?.height === right.size?.height
  );
}

export function isIntegerInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function validateQuality(quality: VideoStreamSocketRequest["quality"]): string | null {
  return quality === undefined || SUPPORTED_QUALITIES.has(quality)
    ? null
    : `Unsupported quality "${quality}"; expected low, medium, or high.`;
}

export function validateFps(fps: VideoStreamSocketRequest["fps"]): string | null {
  return fps === undefined || isIntegerInRange(fps, MIN_FPS_HINT, MAX_FPS_HINT)
    ? null
    : `Invalid fps ${fps}; expected an integer between ${MIN_FPS_HINT} and ${MAX_FPS_HINT}.`;
}

export function validateBitrate(
  bitrateKbps: VideoStreamSocketRequest["bitrateKbps"],
): string | null {
  return bitrateKbps === undefined || isIntegerInRange(bitrateKbps, 1, MAX_BITRATE_KBPS)
    ? null
    : `Invalid bitrateKbps ${bitrateKbps}; expected an integer between 1 and ${MAX_BITRATE_KBPS}.`;
}

export function validateSize(size: VideoStreamSocketRequest["size"]): string | null {
  if (size === undefined) {
    return null;
  }
  const { width, height } = size ?? {};
  return isIntegerInRange(width, 2, Number.MAX_SAFE_INTEGER) &&
    isIntegerInRange(height, 2, Number.MAX_SAFE_INTEGER)
    ? null
    : `Invalid size ${JSON.stringify(size)}; expected integer width/height >= 2.`;
}

/**
 * Validate the optional capture hints on a subscribe request, returning an error message for the
 * first invalid field or null when all hints are usable. TypeScript's wire types are erased at
 * runtime, so this is the only thing standing between a malformed hint and the encoder argv.
 */
export function validateCaptureHints(
  request: Omit<VideoStreamSocketRequest, "platform"> & { platform?: unknown },
): string | null {
  return (
    validatePlatform(request.platform) ??
    validateQuality(request.quality) ??
    validateFps(request.fps) ??
    validateBitrate(request.bitrateKbps) ??
    validateSize(request.size)
  );
}

export function validatePlatform(platform: unknown): string | null {
  return platform === undefined || platform === "android" || platform === "ios"
    ? null
    : `Invalid platform ${JSON.stringify(platform)}; expected "android" or "ios".`;
}

export function subscribeFailureResponse(
  requestId: string | undefined,
  error: unknown,
): VideoStreamSocketResponse {
  if (error instanceof ScreenRecordingPermissionError) {
    return {
      id: requestId,
      type: "video_stream_response",
      success: false,
      permission: {
        kind: "screen_recording",
        status: "needs_approval",
        approvalTarget: error.approvalTarget,
      },
      // Keep pre-permission desktop clients actionable during rolling updates.
      error: error.message,
    };
  }
  return {
    id: requestId,
    type: "video_stream_response",
    success: false,
    error: errorMessage(error),
    ...streamAuthRefusalFields(error),
  };
}
