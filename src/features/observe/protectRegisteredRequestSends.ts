import type WebSocket from "ws";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { RequestManager } from "../../utils/RequestManager";
import type { CtrlSocket } from "./shared/types";

/**
 * Every CtrlProxy request carries its correlation ID in the JSON payload. A
 * synchronous ws.send failure otherwise bypasses the request awaiter's error
 * path and leaves that registration pending until a later timeout or close.
 */
export function protectRegisteredRequestSends(
  ws: CtrlSocket,
  requestManager: Pick<RequestManager, "reject">,
  logTag: string,
): void {
  const send = ws.send.bind(ws);
  ws.send = (...args: Parameters<CtrlSocket["send"]>) => {
    try {
      return send(...args);
    } catch (error) {
      const requestId = requestIdFromWireData(args[0], logTag);
      if (requestId) {
        requestManager.reject(requestId, error instanceof Error ? error : new Error(String(error)));
      }
      logger.debug(
        `[${logTag}] WebSocket send failed${requestId ? ` for request ${requestId}` : ""}: ${errorMessage(error)}`,
      );
      throw error;
    }
  };
}

function requestIdFromWireData(data: WebSocket.Data, logTag: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(data.toString());
    if (typeof parsed !== "object" || parsed === null || !("requestId" in parsed)) {
      return undefined;
    }
    return typeof parsed.requestId === "string" ? parsed.requestId : undefined;
  } catch (error) {
    // An unparseable send has no request ID to reject; the original send error still surfaces.
    logger.debug(
      `[${logTag}] Could not read request ID from failed WebSocket send: ${errorMessage(error)}`,
    );
    return undefined;
  }
}
