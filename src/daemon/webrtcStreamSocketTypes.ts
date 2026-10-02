import type {
  StreamSubscriptionKind,
  StreamSubscriptionEndReason,
} from "./streamSubscriptionPolicy";
import type { SocketRequest, SocketResponse } from "./socketServer/index";
import type { WebRtcStreamDescriptor } from "../features/webrtc";

export type WebRtcStreamAction = "start" | "stop" | "status" | "list" | "await";

export interface WebRtcIceServerInput {
  urls: string;
  username?: string;
  credential?: string;
}

/**
 * Request to the WebRTC stream socket server. `start` publishes a device's
 * screen to the coordination server over WHIP; `stop`/`status`/`list` manage and
 * inspect active streams. All override fields are optional — defaults come from
 * the `AUTOMOBILE_WEBRTC_*` environment variables.
 */
export interface WebRtcStreamSocketRequest extends SocketRequest {
  action: WebRtcStreamAction;
  /**
   * Session UUID admitting this request (issue #4751). The daemon authenticates
   * every action against its live session registry (the #4655 session mechanism)
   * and rejects a request whose session is absent, unknown, or bound to a
   * different device.
   */
  sessionUuid?: string;
  /** Target device id (defaults to the sole connected Android device). */
  deviceId?: string;
  platform?: "android" | "ios";
  streamId?: string;
  /** Lease returned by start; renew it with status/await or release it with stop. */
  leaseId?: string;
  whipEndpoint?: string;
  whipToken?: string;
  iceServers?: WebRtcIceServerInput[];
  bitrateKbps?: number;
  size?: { width: number; height: number };
  /** iOS Simulator capture rate; integer in the range documented by the seam. */
  iosSimulatorFps?: number;
  /** Android video-server capture rate (`--fps`); integer in the documented range. */
  androidFps?: number;
  /** Enable optional audio capture/publishing. */
  audio?: boolean;
  /** Override the environment's Trickle ICE setting for this stream. */
  trickleIce?: boolean;
  /** Readiness phase for the `await` action. */
  readiness?: "capture_ready" | "publishing";
  /** Bounded wait for the `await` action. */
  timeoutMs?: number;
}

/**
 * A viewer lease survives device ownership changes; an owner losing ownership
 * downgrades to a read-only viewer. The downgrade is one-way; either kind may release or
 * renew its own lease with compatible parameters, subject to unchanged start admission.
 * Ends report device_removed, device_restored (VM restore), identity_quarantined,
 * daemon_shutdown, session_ended,
 * or stopped_by_owner when the current device owner stops the stream outright.
 * This socket has no push channel: typed ends are reported on the next request carrying
 * the lease. These optional
 * fields are additive for older clients; start remains a fresh admission.
 * errorCode is viewer_read_only for stream control by viewers, or viewer_stream_active
 * when a new owner's start conflicts with parameters on another session's viewer stream
 * (stop it first). Parameter errors name keys only, never values or tokens.
 */
export interface WebRtcStreamSocketResponse extends SocketResponse {
  type: "webrtc_stream_response";
  action?: WebRtcStreamAction;
  subscriptionKind?: StreamSubscriptionKind;
  reason?: StreamSubscriptionEndReason;
  errorCode?: string;
  /** Reconnect descriptor for a single stream (start/stop/status). */
  stream?: WebRtcStreamDescriptor;
  /** Reconnect descriptors for all active streams (list). */
  streams?: WebRtcStreamDescriptor[];
  /** Stable reason a stream degraded, suitable for screenshot fallback. */
  failure?: { code: string; message: string; at: string } | null;
}
