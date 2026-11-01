import { WatchRunnerError } from "./WatchRunnerError";
import WebSocket from "ws";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { isWatchHierarchy, type WatchHierarchyNode } from "./WatchHierarchy";

export type WatchCommand =
  | { type: "hierarchy" | "home" }
  | { type: "tap"; identifier: string }
  | { type: "tap"; x: number; y: number }
  | { type: "swipe"; direction: "up" | "down" | "left" | "right" };

export interface WatchRunnerClient {
  request(command: WatchCommand, signal?: AbortSignal): Promise<unknown>;
  hierarchy(signal?: AbortSignal): Promise<WatchHierarchyNode>;
  close(): void;
}

/** The socket seam keeps unit tests independent of ws and real network connections. */
export interface WatchSocket {
  send(message: string): void;
  close(): void;
  onMessage(listener: (message: string) => void): void;
  onFailure(listener: (error: Error) => void): void;
}
export type WatchSocketFactory = (url: string) => WatchSocket;
export const webSocketWatchFactory: WatchSocketFactory = (url) => {
  const socket = new WebSocket(url);
  return {
    send: (message) => socket.send(message),
    close: () => socket.close(),
    onMessage: (listener) => {
      socket.on("message", (data) => listener(data.toString()));
    },
    onFailure: (listener) => {
      socket.on("error", listener);
      socket.on("close", () => listener(new Error("Watch runner disconnected; reconnect it.")));
    },
  };
};

interface Pending {
  type: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export class WebSocketWatchRunnerClient implements WatchRunnerClient {
  private readonly socket: WatchSocket;
  private readonly pending = new Map<string, Pending>();
  private sequence = 0;
  private supported = new Set<string>();
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: unknown) => void;
  private failure?: ActionableError;

  constructor(
    url: string,
    private readonly options: {
      factory?: WatchSocketFactory;
      timer?: Timer;
      timeoutMs?: number;
    } = {},
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A runner can disconnect before the first caller awaits the handshake.
    void this.ready.then(undefined, () => {});
    this.socket = (options.factory ?? webSocketWatchFactory)(url);
    this.socket.onMessage((message) => this.receive(message));
    this.socket.onFailure((error) =>
      this.fail(toActionableError(error, "Watch runner connection failed")),
    );
  }

  private fail(error: ActionableError): void {
    this.failure = error;
    this.rejectReady(error);
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private receive(message: string): void {
    try {
      const value: unknown = JSON.parse(message);
      if (!value || typeof value !== "object" || !("type" in value)) {
        throw new ActionableError("Invalid watch runner response; reconnect it.");
      }
      const response = value as Record<string, unknown>;
      if (response.type === "connected") {
        this.connected(response);
      } else {
        this.reply(response);
      }
    } catch (error) {
      this.fail(toActionableError(error, "Invalid watch runner response"));
      this.socket.close();
    }
  }

  private connected(response: Record<string, unknown>): void {
    if (response.platform !== "watchos") {
      this.fail(
        new WatchRunnerError(
          "Refusing runner: connected platform must be watchos.",
          "invalid_runner_platform",
        ),
      );
      this.socket.close();
      return;
    }
    this.supported = new Set(
      Array.isArray(response.supportedCommands)
        ? response.supportedCommands.filter((item): item is string => typeof item === "string")
        : [],
    );
    this.resolveReady();
    return;
  }
  private reply(response: Record<string, unknown>): void {
    const pending =
      typeof response.requestId === "string" ? this.pending.get(response.requestId) : undefined;
    if (!pending) {
      return;
    }
    if (response.type === "error" || response.success === false) {
      pending.reject(
        new WatchRunnerError(
          String(response.error ?? "Watch command failed"),
          String(response.errorCode ?? "command_failed"),
        ),
      );
    } else if (
      response.type ===
        (pending.type === "hierarchy" ? "hierarchy_update" : `${pending.type}_result`) &&
      response.success === true
    ) {
      pending.resolve(response.data);
    }
  }

  async request(command: WatchCommand, signal?: AbortSignal): Promise<unknown> {
    const timer = this.options.timer ?? defaultTimer;
    const timeoutMs = this.options.timeoutMs ?? 5000;
    // One budget covers both handshake and command; correlation entries are removed even on abort.
    const requestId = String(++this.sequence);
    const cancellation = new AbortController();
    const requestSignal = signal
      ? AbortSignal.any([signal, cancellation.signal])
      : cancellation.signal;
    try {
      return await raceWithDeadline(
        async () => {
          await this.ready;
          requestSignal.throwIfAborted();
          if (this.failure) {
            throw this.failure;
          }
          if (!this.supported.has(command.type)) {
            throw new WatchRunnerError(
              `The watch runner does not support ${command.type}.`,
              "unsupported_on_watchos",
            );
          }
          return new Promise<unknown>((resolve, reject) => {
            this.pending.set(requestId, { type: command.type, resolve, reject });
            this.socket.send(JSON.stringify({ ...command, requestId }));
          });
        },
        { timer, timeoutMs, signal: requestSignal, label: `Watch runner ${command.type}` },
      );
    } finally {
      cancellation.abort();
      this.pending.delete(requestId);
    }
  }

  async hierarchy(signal?: AbortSignal): Promise<WatchHierarchyNode> {
    const data = await this.request({ type: "hierarchy" }, signal);
    if (!isWatchHierarchy(data)) {
      throw new ActionableError("Invalid watch hierarchy; reconnect the runner.");
    }
    return data;
  }
  close(): void {
    this.fail(new ActionableError("Watch runner closed; reconnect it."));
    this.socket.close();
  }
}
