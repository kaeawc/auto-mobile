import { TvosRunnerDisconnectedError } from "./TvosRunnerDisconnectedError";
import { TvosRunnerError } from "./TvosRunnerError";
import { TvosRunnerTimeoutError } from "./TvosRunnerTimeoutError";
import WebSocket from "ws";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { isTvosHierarchy, type TvosHierarchy } from "./TvosHierarchy";
import type { TvosAppExit } from "./TvosAppExit";

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
/** `bundleId` names the app the daemon believes is in front; the runner checks it is (#17310). */
export type TvosCommand =
  | { type: "request_hierarchy"; bundleId?: string }
  | { type: "request_screenshot" }
  | { type: "request_press_button"; action: TVRemoteButton; bundleId?: string }
  | { type: "request_append_text"; text: string; bundleId?: string };

/** Each runner command's deadline; a runner that misses one is treated as stuck. */
export const TVOS_RUNNER_COMMAND_TIMEOUT_MS = 5000;

export interface TvosRunnerClient {
  /** Registered clients remain reusable until a permanent connection failure or close. */
  isUsable(): boolean;
  request(
    command: TvosCommand,
    signal?: AbortSignal,
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
  hierarchy(signal?: AbortSignal): Promise<TvosHierarchy>;
  /** Unexpected runner-process termination, eligible for app-exit diagnosis. */
  runnerExited(): void;
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
  private connectionLost = false;

  constructor(
    url: string,
    private readonly options: {
      factory?: TvosSocketFactory;
      timer?: Timer;
      timeoutMs?: number;
      /** The app last launched on this device, sent as the hierarchy, press and text target hint. */
      foregroundApp?: () => string | undefined;
      appExit?: Pick<TvosAppExit, "diagnose">;
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
    this.socket.onFailure((error) => {
      if (!this.failure) {
        this.connectionLost = true;
      }
      this.fail(toActionableError(error, "Tvos runner connection failed"));
    });
  }

  isUsable(): boolean {
    return this.failure === undefined;
  }

  private fail(error: ActionableError): void {
    // Keep the first cause: closing the socket reports a generic disconnect afterwards.
    this.failure ??= error;
    this.rejectReady(this.failure);
    for (const pending of this.pending.values()) {
      pending.reject(this.failure);
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
    const timeoutMs =
      options?.timeoutMs ?? this.options.timeoutMs ?? TVOS_RUNNER_COMMAND_TIMEOUT_MS;
    // One budget covers both handshake and command; correlation entries are removed even on abort.
    const requestId = String(++this.sequence);
    const cancellation = new AbortController();
    const requestSignal = signal
      ? AbortSignal.any([signal, cancellation.signal])
      : cancellation.signal;
    const targeted = this.withForegroundHint(command);
    const startedAt = timer.now();
    const message = JSON.stringify({ ...targeted, requestId });
    // A missed handshake keeps the generic timeout so startup can retry; a sent command that
    // gets no answer means the runner is stuck.
    let dispatched = false;
    let timedOut: TvosRunnerTimeoutError | undefined;
    const stuck = () => (timedOut ??= new TvosRunnerTimeoutError(command.type, timeoutMs));
    try {
      return await raceWithDeadline(
        async () => {
          await this.ready;
          requestSignal.throwIfAborted();
          if (this.failure) {
            // The connection was lost after the handshake: report this command, not the earlier
            // failure that disconnected the runner (#17384).
            throw new TvosRunnerDisconnectedError(command.type, this.failure);
          }
          if (!this.supported.has(command.type)) {
            throw new TvosRunnerError(
              `The tvos runner does not support ${command.type}.`,
              "unsupported_on_tvos",
            );
          }
          return new Promise<unknown>((resolve, reject) => {
            this.pending.set(requestId, { type: command.type, resolve, reject });
            dispatched = true;
            this.socket.send(message);
          });
        },
        {
          timer,
          timeoutMs,
          signal: requestSignal,
          label: `Tvos runner ${command.type}`,
          timeoutError: () => (dispatched ? stuck() : undefined),
          onTimeout: () => {
            if (dispatched) {
              this.connectionLost = true;
              this.fail(stuck());
              this.socket.close();
            }
          },
        },
      );
    } catch (error) {
      throw await this.requestError(error, targeted, { dispatched, startedAt, signal });
    } finally {
      cancellation.abort();
      this.pending.delete(requestId);
    }
  }

  private async requestError(
    error: unknown,
    command: TvosCommand,
    state: { dispatched: boolean; startedAt: number; signal?: AbortSignal },
  ): Promise<ActionableError> {
    state.signal?.throwIfAborted();
    const bundleId = "bundleId" in command ? command.bundleId : undefined;
    if (state.dispatched && bundleId && this.connectionLost && error === this.failure) {
      const exited = await this.options.appExit?.diagnose(
        bundleId,
        command.type,
        state.startedAt,
        state.signal,
      );
      if (exited) {
        return exited;
      }
    }
    return toActionableError(error, "tvOS runner request failed");
  }

  /** Names the last-launched app on commands that read an app, unless the caller named one. */
  private withForegroundHint(command: TvosCommand): TvosCommand {
    if (
      (command.type !== "request_hierarchy" &&
        command.type !== "request_append_text" &&
        command.type !== "request_press_button") ||
      command.bundleId?.trim()
    ) {
      return command;
    }
    const bundleId = this.options.foregroundApp?.();
    return bundleId ? { ...command, bundleId } : command;
  }

  async hierarchy(signal?: AbortSignal): Promise<TvosHierarchy> {
    const data = await this.request({ type: "request_hierarchy" }, signal);
    if (!isTvosHierarchy(data)) {
      throw new ActionableError("Invalid tvos hierarchy; reconnect the runner.");
    }
    return data;
  }
  runnerExited(): void {
    if (!this.failure) {
      this.connectionLost = true;
    }
    this.fail(new ActionableError("Tvos runner process exited; reconnect it."));
    this.socket.close();
  }

  close(): void {
    this.fail(new ActionableError("Tvos runner closed; reconnect it."));
    this.socket.close();
  }
}
