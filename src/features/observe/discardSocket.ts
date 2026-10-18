/**
 * Socket teardown helper shared by the device service client connection lifecycle.
 */

import type WebSocket from "ws";
import { logger } from "../../utils/logger";

/**
 * Detach a socket's lifecycle listeners and close it.
 *
 * Listeners are removed BEFORE closing so the socket's delayed close/error cannot
 * mutate state for a replacement connection. A lone swallowing `error` listener is
 * kept: a socket torn down mid-handshake can still emit "error", and an
 * EventEmitter with no "error" listener THROWS, which would crash the daemon.
 * Close failures are logged and swallowed because the socket is going away anyway.
 */
export function discardSocket(ws: WebSocket, logTag: string, description: string): void {
  try {
    ws.removeAllListeners();
    ws.on("error", (error) => {
      logger.debug(`[${logTag}] Ignoring error on ${description} WebSocket: ${error}`);
    });
    ws.close();
  } catch (error) {
    // The socket may already be closing; nothing else to clean up.
    logger.debug(`[${logTag}] Error closing ${description} WebSocket: ${error}`);
  }
}
