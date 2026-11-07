import { VisionosRunnerError } from "./VisionosRunnerError";
import WebSocket from "ws";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { isVisionosHierarchy, type VisionosHierarchy } from "./VisionosHierarchy";

export type VisionosCommand =
  | { type: "request_hierarchy" }
  | { type: "request_tap_element"; identifier: string; label?: string; elementType?: number }
  | { type: "request_append_text"; text: string };

/** Default budget for commands other than hierarchy, and for the connected handshake. */
export const VISIONOS_REQUEST_TIMEOUT_MS = 5000;
/**
 * Default hierarchy budget. A runner automating a system app (Settings, Safari) can take about
 * 8 s to answer its first snapshot (#17199), so the 5 s command budget is too short.
 */
export const VISIONOS_HIERARCHY_TIMEOUT_MS = 20_000;

export interface VisionosRunnerClient {
  /** Registered clients remain reusable until a permanent connection failure or close. */
  isUsable(): boolean;
  /**
   * Resolve once the runner's `connected` handshake arrives. It is sent when the socket is
   * accepted, so it proves the runner is serving without paying for a hierarchy snapshot.
   */
  waitUntilConnected(signal?: AbortSignal, options?: { timeoutMs?: number }): Promise<void>;
  request(
    command: VisionosCommand,
    signal?: AbortSignal,
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
  hierarchy(signal?: AbortSignal, options?: { timeoutMs?: number }): Promise<VisionosHierarchy>;
  close(): void;
}

/** The socket seam keeps unit tests independent of ws and real network connections. */
export interface VisionosSocket {
  send(message: string): void;
  close(): void;
  onMessage(listener: (message: string) => void): void;
  onFailure(listener: (error: Error) => void): void;
}
export type VisionosSocketFactory = (url: string) => VisionosSocket;
export const webSocketVisionosFactory: VisionosSocketFactory = (url) => {
  const socket = new WebSocket(url);
  return {
    send: (message) => socket.send(message),
    close: () => socket.close(),
    onMessage: (listener) => {
      socket.on("message", (data) => listener(data.toString()));
    },
    onFailure: (listener) => {
      socket.on("error", listener);
      socket.on("close", () => listener(new Error("Visionos runner disconnected; reconnect it.")));
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
    : `${requestType.slice("request_".length)}_result`;
}

function defaultTimeoutMs(command: VisionosCommand): number {
  return command.type === "request_hierarchy"
    ? VISIONOS_HIERARCHY_TIMEOUT_MS
    : VISIONOS_REQUEST_TIMEOUT_MS;
}

export class WebSocketVisionosRunnerClient implements VisionosRunnerClient {
  private readonly socket: VisionosSocket;
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
      factory?: VisionosSocketFactory;
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
    this.socket = (options.factory ?? webSocketVisionosFactory)(url);
    this.socket.onMessage((message) => this.receive(message));
    this.socket.onFailure((error) =>
      this.fail(toActionableError(error, "Visionos runner connection failed")),
    );
  }

  isUsable(): boolean {
    return this.failure === undefined;
  }

  async waitUntilConnected(signal?: AbortSignal, options?: { timeoutMs?: number }): Promise<void> {
    await raceWithDeadline(
      async () => {
        await this.ready;
        if (this.failure) {
          throw this.failure;
        }
      },
      {
        timer: this.options.timer ?? defaultTimer,
        timeoutMs: options?.timeoutMs ?? this.options.timeoutMs ?? VISIONOS_REQUEST_TIMEOUT_MS,
        signal,
        label: "Visionos runner connected handshake",
      },
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
        throw new ActionableError("Invalid visionos runner response; reconnect it.");
      }
      const response = value as Record<string, unknown>;
      if (response.type === "connected") {
        this.connected(response);
      } else {
        this.reply(response);
      }
    } catch (error) {
      this.fail(toActionableError(error, "Invalid visionos runner response"));
      this.socket.close();
    }
  }

  private connected(response: Record<string, unknown>): void {
    if (response.platform !== "visionos") {
      this.fail(
        new VisionosRunnerError(
          "Refusing runner: connected platform must be visionos.",
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
      const runnerError = String(response.error ?? "Visionos command failed");
      if (runnerError.includes("kAXErrorAPIDisabled")) {
        pending.reject(
          new VisionosRunnerError(
            "The visionOS simulator's accessibility API is disabled, so no hierarchy can be read for the built-in app. Re-create the Apple Vision Pro simulator or boot it with accessibility enabled, then observe again.",
            "accessibility_api_disabled",
            { cause: runnerError },
          ),
        );
        return;
      }
      pending.reject(
        new VisionosRunnerError(runnerError, String(response.errorCode ?? "command_failed")),
      );
    } else if (
      response.type === expectedReplyType(pending.type) &&
      (response.success === true ||
        (pending.type === "request_hierarchy" && response.success === undefined))
    ) {
      pending.resolve(response.data);
    }
  }

  async request(
    command: VisionosCommand,
    signal?: AbortSignal,
    options?: { timeoutMs?: number },
  ): Promise<unknown> {
    const timer = this.options.timer ?? defaultTimer;
    const timeoutMs = options?.timeoutMs ?? this.options.timeoutMs ?? defaultTimeoutMs(command);
    // One budget covers both handshake and command; correlation entries are removed even on abort.
    const requestId = String(++this.sequence);
    const cancellation = new AbortController();
    const isInput = command.type !== "request_hierarchy";
    let sent = false;
    let replied = false;
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
            throw new VisionosRunnerError(
              `The visionos runner does not support ${command.type}.`,
              "unsupported_on_visionos",
            );
          }
          return new Promise<unknown>((resolve, reject) => {
            this.pending.set(requestId, {
              type: command.type,
              resolve: (value) => {
                replied = true;
                resolve(value);
              },
              reject: (error) => {
                replied = true;
                reject(error);
              },
            });
            this.socket.send(JSON.stringify({ ...command, requestId }));
            sent = true;
          });
        },
        { timer, timeoutMs, signal: requestSignal, label: `Visionos runner ${command.type}` },
      );
    } catch (error) {
      // The runner has no cancel message: an input that was sent and never answered may still run.
      if (sent && !replied && isInput && !signal?.aborted) {
        throw new VisionosRunnerError(
          `Visionos runner ${command.type} got no reply within ${timeoutMs}ms and may still be applied; observe before retrying.`,
          "input_outcome_unknown",
          { cause: error },
        );
      }
      throw error;
    } finally {
      cancellation.abort();
      this.pending.delete(requestId);
    }
  }

  async hierarchy(
    signal?: AbortSignal,
    options?: { timeoutMs?: number },
  ): Promise<VisionosHierarchy> {
    const data = await this.request({ type: "request_hierarchy" }, signal, options);
    if (!isVisionosHierarchy(data)) {
      throw new ActionableError("Invalid visionos hierarchy; reconnect the runner.");
    }
    return data;
  }
  close(): void {
    this.fail(new ActionableError("Visionos runner closed; reconnect it."));
    this.socket.close();
  }
}
