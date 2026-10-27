import type WebSocket from "ws";
import type { RequestManager } from "../../utils/RequestManager";
import type { Timer } from "../../utils/SystemTimer";
import type { CtrlSocket } from "./shared/types";

/** Connection bookkeeping a test may read; the non-readonly fields are writable to arrange state. */
export interface DeviceServiceClientConnectionState {
  /** Background auto-reconnect; tests turn it off so a failed connect does not re-arm. */
  autoReconnectEnabled: boolean;
  /** Commands the last handshake advertised; null before one and after a port change. */
  supportedCommands: Set<string> | null;
  /** True while a connect attempt owns the socket slot. */
  readonly isConnecting: boolean;
  /** Callers joined to the in-flight connect. */
  readonly pendingConnectJoiners: number;
  readonly inFlightConnectPromise: Promise<boolean> | null;
  /** Handle of the armed background reconnect, or null when none is scheduled. */
  readonly reconnectTimeoutId: ReturnType<Timer["setTimeout"]> | null;
  /** Attempts in the current budget window; with lastConnectionAttempt, arranges a cooldown. */
  connectionAttempts: number;
  lastConnectionAttempt: number;
}

type WritableConnectionState = Pick<
  DeviceServiceClientConnectionState,
  "autoReconnectEnabled" | "supportedCommands" | "connectionAttempts" | "lastConnectionAttempt"
>;

/** Typed view of the client's connection socket and state for unit tests; production code must not use it. */
export interface DeviceServiceClientConnectionTestHooks extends DeviceServiceClientConnectionState {
  /** The currently installed socket; assign an open fake to skip connection provisioning. */
  socket: CtrlSocket | null;
  /** The client's in-flight request table, for registering requests a fake runner answers. */
  readonly requestManager: RequestManager;
  /** Feed one inbound frame through the client's own message handler, as the socket would. */
  deliverMessage(data: WebSocket.Data): void | Promise<void>;
  /** Polls until the handshake completes or its budget (or `signal`) ends. */
  waitForHandshake(timeoutMs?: number, signal?: AbortSignal): Promise<void>;
}

/** Builds the hooks over a client's socket slot and handlers; `socket` reads and writes live state. */
export function createConnectionTestHooks(client: {
  getSocket(): CtrlSocket | null;
  setSocket(socket: CtrlSocket | null): void;
  requestManager: RequestManager;
  deliverMessage(data: WebSocket.Data): void | Promise<void>;
  waitForHandshake(timeoutMs?: number, signal?: AbortSignal): Promise<void>;
  readState(): DeviceServiceClientConnectionState;
  writeState(patch: Partial<WritableConnectionState>): void;
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
    waitForHandshake: (timeoutMs, signal) => client.waitForHandshake(timeoutMs, signal),
    get autoReconnectEnabled() {
      return client.readState().autoReconnectEnabled;
    },
    set autoReconnectEnabled(value: boolean) {
      client.writeState({ autoReconnectEnabled: value });
    },
    get supportedCommands() {
      return client.readState().supportedCommands;
    },
    set supportedCommands(value: Set<string> | null) {
      client.writeState({ supportedCommands: value });
    },
    get isConnecting() {
      return client.readState().isConnecting;
    },
    get pendingConnectJoiners() {
      return client.readState().pendingConnectJoiners;
    },
    get inFlightConnectPromise() {
      return client.readState().inFlightConnectPromise;
    },
    get reconnectTimeoutId() {
      return client.readState().reconnectTimeoutId;
    },
    get connectionAttempts() {
      return client.readState().connectionAttempts;
    },
    set connectionAttempts(value: number) {
      client.writeState({ connectionAttempts: value });
    },
    get lastConnectionAttempt() {
      return client.readState().lastConnectionAttempt;
    },
    set lastConnectionAttempt(value: number) {
      client.writeState({ lastConnectionAttempt: value });
    },
  };
}
