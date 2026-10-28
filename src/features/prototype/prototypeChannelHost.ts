/**
 * Device-facing side of host-proxied prototype channels (#14268): decodes `prototype_channel_*`
 * frames from one socket, runs them through the coordinator and relays the connection's lifecycle
 * back on the same transport.
 */
import type { CtrlSocket } from "../observe/shared/types";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { PrototypeChannelCoordinator } from "./PrototypeChannelCoordinator";
import {
  PROTOTYPE_CHANNEL_CLOSE_MESSAGE_TYPE,
  PROTOTYPE_CHANNEL_CLOSED_MESSAGE_TYPE,
  PROTOTYPE_CHANNEL_FRAME_MESSAGE_TYPE,
  PROTOTYPE_CHANNEL_OPEN_MESSAGE_TYPE,
  PROTOTYPE_CHANNEL_OPENED_MESSAGE_TYPE,
  PROTOTYPE_CHANNEL_SEND_MESSAGE_TYPE,
  prototypeChannelCloseMessageSchema,
  prototypeChannelOpenMessageSchema,
  prototypeChannelSendMessageSchema,
  type PrototypeChannelOutboundMessage,
} from "./prototypeChannelProtocol";

export type PrototypeChannelSender = (message: PrototypeChannelOutboundMessage) => void;

/** Writes channel messages to the device socket; throws when it is not open (they are then moot). */
export function webSocketChannelSender(
  getWebSocket: () => Pick<CtrlSocket, "readyState" | "send"> | null,
): PrototypeChannelSender {
  return (message) => {
    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    ws.send(JSON.stringify(message));
  };
}

/** The device-to-host frame types a client routes to a channel host. */
export const PROTOTYPE_CHANNEL_DEVICE_FRAME_TYPES: ReadonlySet<string> = new Set([
  PROTOTYPE_CHANNEL_OPEN_MESSAGE_TYPE,
  PROTOTYPE_CHANNEL_SEND_MESSAGE_TYPE,
  PROTOTYPE_CHANNEL_CLOSE_MESSAGE_TYPE,
]);

/**
 * Routes one device frame to `host`; with no host attached an open is answered with a closed frame
 * (so the device's state machine can fail the channel) and the other frames are dropped.
 */
export function routePrototypeChannelFrame(
  host: PrototypeChannelHost | undefined,
  frame: unknown,
  send: PrototypeChannelSender,
): void {
  const type = (frame as { type?: unknown } | null)?.type;
  if (host === undefined) {
    if (type === PROTOTYPE_CHANNEL_OPEN_MESSAGE_TYPE) {
      const connectionId = (frame as { connectionId?: unknown }).connectionId;
      logger.warn("[PrototypeChannel] prototype_channel_open received but no host is attached");
      reply(send, {
        type: PROTOTYPE_CHANNEL_CLOSED_MESSAGE_TYPE,
        connectionId: typeof connectionId === "string" ? connectionId : "",
        error: { code: "network", message: "The host channel proxy is not available." },
      });
    }
    return;
  }
  if (type === PROTOTYPE_CHANNEL_OPEN_MESSAGE_TYPE) {
    host.handleOpen(frame, send);
  } else if (type === PROTOTYPE_CHANNEL_SEND_MESSAGE_TYPE) {
    host.handleSend(frame);
  } else if (type === PROTOTYPE_CHANNEL_CLOSE_MESSAGE_TYPE) {
    host.handleClose(frame);
  }
}

/** What a platform client calls when a `prototype_channel_*` frame or a disconnect arrives. */
export interface PrototypeChannelHost {
  handleOpen(frame: unknown, send: PrototypeChannelSender): void;
  /** A device frame for an open connection; no reply. */
  handleSend(frame: unknown): void;
  handleClose(frame: unknown): void;
  handleDisconnect(): void;
}

export function createPrototypeChannelHost(
  deviceId: string,
  coordinator: Pick<PrototypeChannelCoordinator, "open" | "send" | "close" | "cancelConnection">,
): PrototypeChannelHost {
  // One host per socket: closing it must not end channels another connection on the same device
  // (a second injected app, or a newer connection) still holds.
  const connection = Symbol(`prototype-channel-host:${deviceId}`);
  return {
    handleOpen(frame, send) {
      const parsed = prototypeChannelOpenMessageSchema.safeParse(frame);
      if (!parsed.success) {
        const connectionId = (frame as { connectionId?: unknown } | null)?.connectionId;
        reply(send, {
          type: PROTOTYPE_CHANNEL_CLOSED_MESSAGE_TYPE,
          connectionId: typeof connectionId === "string" ? connectionId : "",
          error: { code: "invalid_request", message: parsed.error.message },
        });
        return;
      }
      const { connectionId, prototypeId, kind, url, protocols, headers, lastEventId } = parsed.data;
      const outcome = coordinator.open(
        { deviceId, prototypeId, connection, connectionId },
        { kind, url, protocols, headers, lastEventId },
        {
          opened: (protocol) =>
            reply(send, {
              type: PROTOTYPE_CHANNEL_OPENED_MESSAGE_TYPE,
              connectionId,
              ...(protocol === undefined ? {} : { protocol }),
            }),
          frame: (channelFrame) =>
            reply(send, {
              type: PROTOTYPE_CHANNEL_FRAME_MESSAGE_TYPE,
              connectionId,
              ...channelFrame,
            }),
          closed: (close) =>
            reply(send, { type: PROTOTYPE_CHANNEL_CLOSED_MESSAGE_TYPE, connectionId, ...close }),
        },
      );
      if (!outcome.ok) {
        reply(send, {
          type: PROTOTYPE_CHANNEL_CLOSED_MESSAGE_TYPE,
          connectionId,
          error: outcome.error,
        });
      }
    },
    handleSend(frame) {
      const parsed = prototypeChannelSendMessageSchema.safeParse(frame);
      if (!parsed.success) {
        return;
      }
      const result = coordinator.send(connection, parsed.data.connectionId, parsed.data.data);
      if (result !== undefined && !result.ok) {
        // The device bounds its own sends; a refusal here means it raced a close or a limit.
        logger.warn(`[PrototypeChannel] send refused (${result.reason})`);
      }
    },
    handleClose(frame) {
      const parsed = prototypeChannelCloseMessageSchema.safeParse(frame);
      if (parsed.success) {
        const { connectionId, code, reason } = parsed.data;
        coordinator.close(connection, connectionId, code, reason);
      }
    },
    handleDisconnect: () => coordinator.cancelConnection(connection),
  };
}

function reply(send: PrototypeChannelSender, message: PrototypeChannelOutboundMessage): void {
  try {
    send(message);
  } catch (error) {
    // The socket can close while a channel is open; the device is gone, so there is no one to tell.
    logger.warn(`[PrototypeChannel] could not relay ${message.type}: ${errorMessage(error)}`);
  }
}
