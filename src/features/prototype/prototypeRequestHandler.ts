/**
 * Device-facing side of host-proxied prototype requests (#12527): decodes a `prototype_request`
 * frame, runs it through the coordinator and replies with one `prototype_response` on the same
 * transport.
 */
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { PrototypeRequestCoordinator } from "./PrototypeRequestCoordinator";
import {
  PROTOTYPE_RESPONSE_MESSAGE_TYPE,
  prototypeRequestMessageSchema,
  type PrototypeResponseMessage,
} from "./prototypeRequestProtocol";

export type PrototypeResponseSender = (response: PrototypeResponseMessage) => void;

/** Writes responses to the device socket; throws when it is not open (the reply is then moot). */
export function webSocketResponseSender(
  getWebSocket: () => Pick<WebSocket, "readyState" | "send"> | null,
): PrototypeResponseSender {
  return (response) => {
    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    ws.send(JSON.stringify(response));
  };
}

/** What a platform client calls when a `prototype_request` frame or a disconnect arrives. */
export interface PrototypeRequestHost {
  handleRequest(frame: unknown, send: PrototypeResponseSender): Promise<void>;
  handleDisconnect(): void;
}

export function createPrototypeRequestHost(
  deviceId: string,
  coordinator: Pick<PrototypeRequestCoordinator, "run" | "cancelConnection">,
): PrototypeRequestHost {
  // One host per socket: closing it must not abort requests another connection on the same
  // device (a second injected app, or a newer connection) is still waiting on.
  const connection = Symbol(`prototype-request-host:${deviceId}`);
  return {
    async handleRequest(frame, send) {
      const parsed = prototypeRequestMessageSchema.safeParse(frame);
      if (!parsed.success) {
        const requestId = (frame as { requestId?: unknown } | null)?.requestId;
        reply(send, {
          type: PROTOTYPE_RESPONSE_MESSAGE_TYPE,
          requestId: typeof requestId === "string" ? requestId : "",
          ok: false,
          error: { code: "invalid_request", message: parsed.error.message },
          durationMs: 0,
        });
        return;
      }
      const { requestId, prototypeId, method, url, headers, body, timeoutMs } = parsed.data;
      const outcome = await coordinator.run(
        { deviceId, prototypeId, connection },
        { method, url, headers, body, timeoutMs },
      );
      reply(send, { type: PROTOTYPE_RESPONSE_MESSAGE_TYPE, requestId, ...outcome });
    },
    handleDisconnect: () => coordinator.cancelConnection(connection),
  };
}

function reply(send: PrototypeResponseSender, response: PrototypeResponseMessage): void {
  try {
    send(response);
  } catch (error) {
    // The socket can close while a request runs; the device is gone, so there is no one to tell.
    logger.warn(`[PrototypeRequest] could not send prototype_response: ${errorMessage(error)}`);
  }
}
