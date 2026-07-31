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

export interface WebRtcStreamSocketResponse extends SocketResponse {
  type: "webrtc_stream_response";
  action?: WebRtcStreamAction;
  /** Reconnect descriptor for a single stream (start/stop/status). */
  stream?: WebRtcStreamDescriptor;
  /** Reconnect descriptors for all active streams (list). */
  streams?: WebRtcStreamDescriptor[];
  /** Stable reason a stream degraded, suitable for screenshot fallback. */
  failure?: { code: string; message: string; at: string } | null;
}
