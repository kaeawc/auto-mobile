import type WebSocket from "ws";
import type { RequestManager } from "../../utils/RequestManager";
import type { CtrlSocket } from "./shared/types";

/** Typed view of the client's connection socket for unit tests; production code must not use it. */
export interface DeviceServiceClientConnectionTestHooks {
  /** The currently installed socket; assign an open fake to skip connection provisioning. */
  socket: CtrlSocket | null;
  /** The client's in-flight request table, for registering requests a fake runner answers. */
  readonly requestManager: RequestManager;
  /** Feed one inbound frame through the client's own message handler, as the socket would. */
  deliverMessage(data: WebSocket.Data): void | Promise<void>;
}

/** Builds the hooks over a client's socket slot and handlers; `socket` reads and writes live state. */
export function createConnectionTestHooks(client: {
  getSocket(): CtrlSocket | null;
  setSocket(socket: CtrlSocket | null): void;
  requestManager: RequestManager;
  deliverMessage(data: WebSocket.Data): void | Promise<void>;
}): DeviceServiceClientConnectionTestHooks {
  return {
    get socket() {
      return client.getSocket();
    },
    set socket(value: CtrlSocket | null) {
      client.setSocket(value);
    },
    requestManager: client.requestManager,
    deliverMessage: (data) => client.deliverMessage(data),
  };
}
