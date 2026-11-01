import { TvosRunnerError } from "./TvosRunnerError";
import WebSocket from "ws";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { isTvosHierarchy, type TvosHierarchy } from "./TvosHierarchy";

export const TV_REMOTE_BUTTONS = [
  "up",
  "down",
  "left",
  "right",
  "select",
  "menu",
  "home",
  "playPause",
] as const;
export type TVRemoteButton = (typeof TV_REMOTE_BUTTONS)[number];
export type TvosCommand =
  | { type: "request_hierarchy" | "request_screenshot" }
  | { type: "request_press_button"; action: TVRemoteButton }
  | { type: "request_append_text"; text: string };

export interface TvosRunnerClient {
  /** Registered clients remain reusable until a permanent connection failure or close. */
  isUsable(): boolean;
  request(
    command: TvosCommand,
    signal?: AbortSignal,
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
  hierarchy(signal?: AbortSignal): Promise<TvosHierarchy>;
  close(): void;
}

/** The socket seam keeps unit tests independent of ws and real network connections. */
export interface TvosSocket {
  send(message: string): void;
  close(): void;
  onMessage(listener: (message: string) => void): void;
  onFailure(listener: (error: Error) => void): void;
}
export type TvosSocketFactory = (url: string) => TvosSocket;
export const webSocketTvosFactory: TvosSocketFactory = (url) => {
  const socket = new WebSocket(url);
  return {
    send: (message) => socket.send(message),
    close: () => socket.close(),
    onMessage: (listener) => {
      socket.on("message", (data) => listener(data.toString()));
    },
    onFailure: (listener) => {
      socket.on("error", listener);
      socket.on("close", () => listener(new Error("Tvos runner disconnected; reconnect it.")));
    },
  };
};

interface Pending {
  type: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

function expectedReplyType(requestType: string): string {
  return requestType === "request_hierarchy"
    ? "hierarchy_update"
    : requestType === "request_screenshot"
      ? "screenshot"
      : `${requestType.slice("request_".length)}_result`;
}

export class WebSocketTvosRunnerClient implements TvosRunnerClient {
  private readonly socket: TvosSocket;
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
      factory?: TvosSocketFactory;
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
    this.socket = (options.factory ?? webSocketTvosFactory)(url);
    this.socket.onMessage((message) => this.receive(message));
    this.socket.onFailure((error) =>
      this.fail(toActionableError(error, "Tvos runner connection failed")),
    );
  }

  isUsable(): boolean {
    return this.failure === undefined;
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
        throw new ActionableError("Invalid tvos runner response; reconnect it.");
      }
      const response = value as Record<string, unknown>;
      if (response.type === "connected") {
        this.connected(response);
      } else {
        this.reply(response);
      }
    } catch (error) {
      this.fail(toActionableError(error, "Invalid tvos runner response"));
      this.socket.close();
    }
  }

  private connected(response: Record<string, unknown>): void {
    if (response.platform !== "tvos") {
      this.fail(
        new TvosRunnerError(
          "Refusing runner: connected platform must be tvos.",
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
        new TvosRunnerError(
          String(response.error ?? "Tvos command failed"),
          String(response.errorCode ?? "command_failed"),
        ),
      );
    } else if (
      response.type === expectedReplyType(pending.type) &&
      (response.success === true ||
        (["request_hierarchy", "request_screenshot"].includes(pending.type) &&
          response.success === undefined))
    ) {
      pending.resolve(response.data);
    }
  }

  async request(
    command: TvosCommand,
    signal?: AbortSignal,
    options?: { timeoutMs?: number },
  ): Promise<unknown> {
    const timer = this.options.timer ?? defaultTimer;
    const timeoutMs = options?.timeoutMs ?? this.options.timeoutMs ?? 5000;
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
            throw new TvosRunnerError(
              `The tvos runner does not support ${command.type}.`,
              "unsupported_on_tvos",
            );
          }
          return new Promise<unknown>((resolve, reject) => {
            this.pending.set(requestId, { type: command.type, resolve, reject });
            this.socket.send(JSON.stringify({ ...command, requestId }));
          });
        },
        { timer, timeoutMs, signal: requestSignal, label: `Tvos runner ${command.type}` },
      );
    } finally {
      cancellation.abort();
      this.pending.delete(requestId);
    }
  }

  async hierarchy(signal?: AbortSignal): Promise<TvosHierarchy> {
    const data = await this.request({ type: "request_hierarchy" }, signal);
    if (!isTvosHierarchy(data)) {
      throw new ActionableError("Invalid tvos hierarchy; reconnect the runner.");
    }
    return data;
  }
  close(): void {
    this.fail(new ActionableError("Tvos runner closed; reconnect it."));
    this.socket.close();
  }
}
