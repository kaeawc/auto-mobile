import { Socket } from "node:net";
import { defaultTimer } from "../utils/SystemTimer";
import type { Timer } from "../utils/SystemTimer";
import { getSocketPath } from "./socketServer/index";
import { WEBRTC_STREAM_SOCKET_CONFIG } from "./daemonFiles";
import { ActionableError } from "../models/ActionableError";
import {
  DAEMON_ONESHOT_CLIENT_MAX_FRAME_BYTES,
  DaemonFrameTooLargeError,
  LineFramer,
} from "./socketServer/LineFramer";
import { webRtcStreamSocketResponseSchema } from "./webrtcStreamSocketTypes";
import type {
  WebRtcStreamSocketRequest,
  WebRtcStreamSocketResponse,
} from "./webrtcStreamSocketTypes";

export const DEFAULT_WEBRTC_STREAM_REQUEST_TIMEOUT_MS = 45_000;

interface WebRtcStreamClientOptions {
  socketPath?: string;
  timeoutMs?: number;
  socketFactory?: () => Socket;
  timer?: Timer;
  maxFrameBytes?: number;
}

/**
 * Minimal client for the WebRTC stream control socket. Connects, sends one
 * newline-delimited JSON request, and resolves with the first response. Intended
 * for CI scripts / tooling that start or stop a stream against a running daemon.
 */
export async function sendWebRtcStreamRequest(
  request: WebRtcStreamSocketRequest,
  options: WebRtcStreamClientOptions = {},
): Promise<WebRtcStreamSocketResponse> {
  const socketPath = options.socketPath ?? getSocketPath(WEBRTC_STREAM_SOCKET_CONFIG);
  const timeoutMs = options.timeoutMs ?? DEFAULT_WEBRTC_STREAM_REQUEST_TIMEOUT_MS;
  const timerSource = options.timer ?? defaultTimer;

  return new Promise<WebRtcStreamSocketResponse>((resolve, reject) => {
    const socket = options.socketFactory?.() ?? new Socket();
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      timerSource.clearTimeout(timer);
      socket.destroy();
      fn();
    };

    const timer = timerSource.setTimeout(() => {
      finish(() => reject(new Error(`WebRTC stream request timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    socket.on("error", (error) => finish(() => reject(error)));
    const maxFrameBytes = options.maxFrameBytes ?? DAEMON_ONESHOT_CLIENT_MAX_FRAME_BYTES;
    const framer = new LineFramer(maxFrameBytes, {
      onOverflow: () => finish(() => reject(new DaemonFrameTooLargeError(maxFrameBytes))),
      onLine: (line) => {
        if (settled || !line.trim()) {
          return;
        }
        let frame: unknown;
        try {
          frame = JSON.parse(line);
        } catch (error) {
          // A malformed peer answer is terminal; preserve the existing parse error contract.
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
          return;
        }
        const response = webRtcStreamSocketResponseSchema.safeParse(frame);
        if (!response.success) {
          finish(() => reject(new ActionableError("Invalid WebRTC stream response envelope")));
          return;
        }
        finish(() => resolve(response.data));
      },
    });
    socket.on("data", (chunk: Buffer) => {
      if (!settled) {
        framer.push(chunk);
      }
    });

    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.connect(socketPath);
  });
}
