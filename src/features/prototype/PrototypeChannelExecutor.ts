/**
 * Host-side transport for prototype channels with `via: "host"` (#14268): the daemon holds the
 * upstream WebSocket or SSE connection and relays frames to the device. Reconnect is not done
 * here; the device's channel state machine owns it, so `via` does not change behaviour.
 */
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { headerProblemOf } from "./PrototypeHttpExecutor";
import type { PrototypeChannelError, PrototypeChannelKind } from "./prototypeChannelProtocol";

export interface PrototypeChannelOpenRequest {
  kind: PrototypeChannelKind;
  url: string;
  protocols?: string[];
  headers?: Record<string, string>;
  /** SSE only: resent as `Last-Event-ID`. */
  lastEventId?: string;
}

export interface PrototypeChannelFrame {
  data: string;
  /** SSE event name and id. */
  event?: string;
  id?: string;
}

export interface PrototypeChannelClose {
  code?: number;
  reason?: string;
  /** Set when the connection ended abnormally or never opened. */
  error?: PrototypeChannelError;
}

/** Receives a connection's lifecycle; `closed` fires at most once and ends the connection. */
export interface PrototypeChannelSink {
  opened(protocol?: string): void;
  frame(frame: PrototypeChannelFrame): void;
  closed(close: PrototypeChannelClose): void;
}

export type PrototypeChannelSendResult =
  | { ok: true }
  | { ok: false; reason: "not_open" | "too_large" | "unsupported" };

export interface PrototypeChannelHandle {
  send(data: string): PrototypeChannelSendResult;
  close(code?: number, reason?: string): void;
}

export interface PrototypeChannelExecutor {
  /**
   * Starts connecting and returns at once. Aborting `signal` ends the connection silently: the
   * device that cancelled it is not told, as for a cancelled request.
   */
  open(
    request: PrototypeChannelOpenRequest,
    sink: PrototypeChannelSink,
    signal: AbortSignal,
  ): PrototypeChannelHandle;
}

export type PrototypeChannelTimer = Pick<
  Timer,
  "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval" | "now"
>;

/** Headers a channel handshake may not carry: the transports set these themselves. */
const CHANNEL_RESERVED_HEADER = /^(sec-websocket-|last-event-id$)/i;

const SCHEMES: Record<PrototypeChannelKind, readonly string[]> = {
  websocket: ["ws:", "wss:"],
  sse: ["http:", "https:"],
};

/** Checks that need no network, so their outcome is deterministic. */
export function channelProblemOf(
  request: PrototypeChannelOpenRequest,
): PrototypeChannelError | undefined {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch (error) {
    // The parse failure is the finding: report it as the typed invalid_url error.
    logger.debug("[PrototypeChannel] URL parse failed.");
    return { code: "invalid_url", message: "Not an absolute URL." };
  }
  if (!SCHEMES[request.kind].includes(url.protocol)) {
    return {
      code: "invalid_url",
      message: `A ${request.kind} channel needs a ${SCHEMES[request.kind].join(" or ")} URL, got ${url.protocol}`,
    };
  }
  const headerProblem = headerProblemOf(request.headers);
  if (headerProblem !== undefined) {
    return { code: "invalid_request", message: headerProblem };
  }
  if (Object.keys(request.headers ?? {}).some((name) => CHANNEL_RESERVED_HEADER.test(name))) {
    return { code: "invalid_request", message: "A request header is not permitted." };
  }
  return undefined;
}

/** Dispatches on `kind` so the coordinator holds one executor. */
export class KindPrototypeChannelExecutor implements PrototypeChannelExecutor {
  constructor(
    private readonly webSocket: PrototypeChannelExecutor,
    private readonly sse: PrototypeChannelExecutor,
  ) {}

  open(
    request: PrototypeChannelOpenRequest,
    sink: PrototypeChannelSink,
    signal: AbortSignal,
  ): PrototypeChannelHandle {
    return (request.kind === "websocket" ? this.webSocket : this.sse).open(request, sink, signal);
  }
}

/**
 * Wraps a sink so `closed` runs once and nothing is delivered after it; shared by both
 * transports so a late frame never follows a close.
 */
export function onceClosedSink(sink: PrototypeChannelSink): {
  sink: PrototypeChannelSink;
  isClosed(): boolean;
  /** Ends delivery without reporting a close, for a connection the host itself cancelled. */
  silence(): void;
} {
  let closed = false;
  return {
    isClosed: () => closed,
    silence: () => {
      closed = true;
    },
    sink: {
      opened: (protocol) => {
        if (!closed) {
          sink.opened(protocol);
        }
      },
      frame: (frame) => {
        if (!closed) {
          sink.frame(frame);
        }
      },
      closed: (close) => {
        if (!closed) {
          closed = true;
          sink.closed(close);
        }
      },
    },
  };
}
