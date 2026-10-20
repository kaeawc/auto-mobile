import WebSocket from "ws";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { WebSocketFactory } from "../DeviceServiceClient";
import type { WebSocketMessage } from "./types";

export function iosDiagnosticSocketFactory(
  factory: WebSocketFactory,
  onConnected: (commands: Set<string> | null, features: Set<string> | null) => void,
): WebSocketFactory {
  return (url) => {
    const socket = factory(url);
    socket.on("message", (data: WebSocket.Data) => {
      try {
        const message: WebSocketMessage = JSON.parse(data.toString());
        if (message.type === "connected") {
          onConnected(
            Array.isArray(message.supportedCommands) ? new Set(message.supportedCommands) : null,
            Array.isArray(message.supportedFeatures) ? new Set(message.supportedFeatures) : null,
          );
        }
      } catch (error) {
        logger.warn(`iOS diagnostic handshake failed: ${errorMessage(error)}`, error);
      }
    });
    return socket;
  };
}
