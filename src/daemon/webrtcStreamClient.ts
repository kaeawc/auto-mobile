import { Socket } from "node:net";
import { defaultTimer } from "../utils/SystemTimer";
import { getSocketPath } from "./socketServer/index";
import { WEBRTC_STREAM_SOCKET_CONFIG } from "./daemonFiles";
import type {
  WebRtcStreamSocketRequest,
  WebRtcStreamSocketResponse,
} from "./webrtcStreamSocketTypes";

export const DEFAULT_WEBRTC_STREAM_REQUEST_TIMEOUT_MS = 45_000;

/**
 * Minimal client for the WebRTC stream control socket. Connects, sends one
 * newline-delimited JSON request, and resolves with the first response. Intended
 * for CI scripts / tooling that start or stop a stream against a running daemon.
 */
export async function sendWebRtcStreamRequest(
  request: WebRtcStreamSocketRequest,
  options: { socketPath?: string; timeoutMs?: number } = {},
): Promise<WebRtcStreamSocketResponse> {
  const socketPath = options.socketPath ?? getSocketPath(WEBRTC_STREAM_SOCKET_CONFIG);
  const timeoutMs = options.timeoutMs ?? DEFAULT_WEBRTC_STREAM_REQUEST_TIMEOUT_MS;

  return new Promise<WebRtcStreamSocketResponse>((resolve, reject) => {
    const socket = new Socket();
    let buffer = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      defaultTimer.clearTimeout(timer);
      socket.destroy();
      fn();
    };

    const timer = defaultTimer.setTimeout(() => {
      finish(() => reject(new Error(`WebRTC stream request timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      if (!line) {
        return;
      }
      try {
        const response = JSON.parse(line) as WebRtcStreamSocketResponse;
        finish(() => resolve(response));
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });

    socket.connect(socketPath, () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
  });
}
