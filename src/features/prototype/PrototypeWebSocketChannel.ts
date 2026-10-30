/**
 * One host-proxied WebSocket channel connection for prototype channels (#14268). It connects only to the
 * address `pinPrototypeDestination` validated, keeping the URL's `Host` and TLS server name, and
 * never follows a handshake redirect. Frames, pings and the handshake deadline run on the
 * injected timer.
 */
import WebSocket from "ws";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  channelProblemOf,
  type onceClosedSink,
  type PrototypeChannelHandle,
  type PrototypeChannelOpenRequest,
  type PrototypeChannelSink,
  type PrototypeChannelTimer,
} from "./PrototypeChannelExecutor";
import {
  MAX_PROTOTYPE_CHANNEL_FRAME_BYTES,
  MAX_PROTOTYPE_CHANNEL_SEND_BYTES,
} from "./prototypeChannelLimits";
import type { PrototypeChannelError } from "./prototypeChannelProtocol";
import {
  pinPrototypeDestination,
  type PrototypeDestinationPinning,
} from "./prototypeDestinationPinning";
import type { ResolvedHostAddress } from "./prototypeEgressPolicy";
import { DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS } from "./prototypeRequestLimits";

export const PROTOTYPE_CHANNEL_PING_INTERVAL_MS = 25_000;

const WS_NORMAL_CLOSURE = 1000;
const WS_GOING_AWAY = 1001;

export interface PrototypeSocketEvents {
  open(protocol: string): void;
  /** A text frame; binary frames are not delivered. */
  message(text: string): void;
  pong(): void;
  close(code: number, reason: string): void;
  /** A frame above the payload cap, which the socket has refused. */
  tooLarge(): void;
  /** The server answered the upgrade with an HTTP response instead. */
  unexpectedResponse(status: number): void;
  error(error: Error): void;
}

/** The slice of a WebSocket the channel needs; tests supply a fake. */
export interface PrototypeSocket {
  send(data: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface PrototypeSocketConnect {
  url: string;
  protocols: string[];
  headers: Record<string, string>;
  pinned: ResolvedHostAddress;
  handshakeTimeoutMs: number;
  maxPayload: number;
}

export type PrototypeSocketFactory = (
  connect: PrototypeSocketConnect,
  events: PrototypeSocketEvents,
) => PrototypeSocket;

/** `ws` connection to the pinned address, with no redirects and no proxy agent. */
export const createWsPrototypeSocket: PrototypeSocketFactory = (connect, events) => {
  const socket = new WebSocket(connect.url, connect.protocols, {
    headers: connect.headers,
    followRedirects: false,
    handshakeTimeout: connect.handshakeTimeoutMs,
    maxPayload: connect.maxPayload,
    // Resolution already happened and was validated; hand the socket that one address.
    lookup: ((
      _hostname: string,
      options: { all?: boolean },
      callback: (...args: unknown[]) => void,
    ) => {
      const entry = { address: connect.pinned.address, family: connect.pinned.family };
      if (options.all) {
        callback(null, [entry]);
      } else {
        callback(null, entry.address, entry.family);
      }
    }) as never,
  });
  socket.on("open", () => events.open(socket.protocol));
  socket.on("message", (data, isBinary) => {
    if (!isBinary) {
      events.message(data.toString());
    }
  });
  socket.on("pong", () => events.pong());
  socket.on("close", (code, reason) => events.close(code, reason.toString()));
  socket.on("unexpected-response", (_request, response) => {
    response.resume();
    events.unexpectedResponse(response.statusCode ?? 0);
  });
  socket.on("error", (error) => {
    if ((error as { code?: string }).code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
      events.tooLarge();
    } else {
      events.error(error);
    }
  });
  return socket;
};

/** The clock, socket constructor and destination pinning one channel connects through. */
export interface PrototypeWebSocketChannelTransport {
  timer: PrototypeChannelTimer;
  socketFactory: PrototypeSocketFactory;
  pinning: PrototypeDestinationPinning;
}

export class PrototypeWebSocketChannel implements PrototypeChannelHandle {
  private socket: PrototypeSocket | undefined;
  private isOpen = false;
  private awaitingPong = false;
  private handshakeTimer: NodeJS.Timeout | undefined;
  /** Aborted when the handshake deadline passes, which also ends a stalled resolution. */
  private readonly deadline = new AbortController();
  private pingTimer: NodeJS.Timeout | undefined;
  private readonly sink: PrototypeChannelSink;
  private readonly timer: PrototypeChannelTimer;
  private readonly socketFactory: PrototypeSocketFactory;
  private readonly pinning: PrototypeDestinationPinning;

  constructor(
    private readonly request: PrototypeChannelOpenRequest,
    private readonly guarded: ReturnType<typeof onceClosedSink>,
    private readonly signal: AbortSignal,
    { timer, socketFactory, pinning }: PrototypeWebSocketChannelTransport,
  ) {
    this.timer = timer;
    this.socketFactory = socketFactory;
    this.pinning = pinning;
    this.sink = guarded.sink;
    signal.addEventListener("abort", () => this.abort(), { once: true });
  }

  async start(): Promise<void> {
    const problem = channelProblemOf(this.request);
    if (problem !== undefined) {
      this.fail(problem);
      return;
    }
    // The deadline covers resolution as well as the upgrade, so a stalled lookup cannot hold the slot.
    this.handshakeTimer = this.timer.setTimeout(() => {
      this.deadline.abort();
      this.fail({ code: "timeout", message: "The WebSocket handshake timed out." });
    }, DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS);
    try {
      const pinned = await pinPrototypeDestination(
        new URL(this.request.url),
        this.pinning,
        AbortSignal.any([this.signal, this.deadline.signal]),
      );
      if (this.signal.aborted || this.guarded.isClosed()) {
        return;
      }
      if ("code" in pinned) {
        this.fail(pinned);
        return;
      }
      this.connect(pinned);
    } catch (error) {
      if (!this.signal.aborted && !this.deadline.signal.aborted) {
        logger.warn(`[PrototypeChannel] websocket could not start: ${errorMessage(error)}`, error);
        this.fail({ code: "network", message: "The connection could not be started." });
      }
    }
  }

  send(data: string) {
    if (!this.isOpen || this.socket === undefined) {
      return { ok: false, reason: "not_open" } as const;
    }
    if (Buffer.byteLength(data) > MAX_PROTOTYPE_CHANNEL_SEND_BYTES) {
      return { ok: false, reason: "too_large" } as const;
    }
    this.socket.send(data);
    return { ok: true } as const;
  }

  close(code: number = WS_NORMAL_CLOSURE, reason?: string): void {
    if (this.socket === undefined) {
      // Closed before the socket existed: nothing to wait for, so the lookup and deadline end too.
      this.deadline.abort();
      this.cleanup();
      this.sink.closed({ code, ...(reason === undefined ? {} : { reason }) });
      return;
    }
    this.socket.close(code, reason);
  }

  private connect(pinned: ResolvedHostAddress): void {
    this.socket = this.socketFactory(
      {
        url: this.request.url,
        protocols: this.request.protocols ?? [],
        headers: this.request.headers ?? {},
        pinned,
        handshakeTimeoutMs: DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS,
        maxPayload: MAX_PROTOTYPE_CHANNEL_FRAME_BYTES,
      },
      this.events(),
    );
  }

  private events(): PrototypeSocketEvents {
    return {
      open: (protocol) => {
        this.clearHandshakeTimer();
        this.isOpen = true;
        this.pingTimer = this.timer.setInterval(
          () => this.ping(),
          PROTOTYPE_CHANNEL_PING_INTERVAL_MS,
        );
        this.sink.opened(protocol === "" ? undefined : protocol);
      },
      message: (text) => {
        if (Buffer.byteLength(text) > MAX_PROTOTYPE_CHANNEL_FRAME_BYTES) {
          this.tooLarge();
        } else {
          this.sink.frame({ data: text });
        }
      },
      pong: () => {
        this.awaitingPong = false;
      },
      close: (code, reason) => {
        this.cleanup();
        this.sink.closed({ code, ...(reason === "" ? {} : { reason }) });
      },
      tooLarge: () => this.tooLarge(),
      unexpectedResponse: (status) =>
        this.fail({
          code: "handshake_failed",
          message: `The server answered the WebSocket upgrade with HTTP ${status}.`,
          status,
        }),
      error: (error) => {
        // Transport error text can carry URLs or credentials; keep only the category.
        logger.warn("[PrototypeChannel] websocket error.", { name: error.name });
        this.fail(
          (error as { code?: string }).code === "ECONNREFUSED"
            ? { code: "connection_refused", message: "Connection refused." }
            : { code: "network", message: "The connection failed." },
        );
      },
    };
  }

  private ping(): void {
    if (this.awaitingPong) {
      this.fail({ code: "network", message: "The server stopped answering pings." });
      return;
    }
    this.awaitingPong = true;
    this.socket?.ping();
  }

  private tooLarge(): void {
    this.fail({
      code: "too_large",
      message: `A frame exceeded ${MAX_PROTOTYPE_CHANNEL_FRAME_BYTES} bytes.`,
    });
  }

  private abort(): void {
    this.guarded.silence();
    this.cleanup();
    this.socket?.close(WS_GOING_AWAY, "Cancelled");
    this.socket?.terminate();
  }

  private fail(error: PrototypeChannelError): void {
    this.cleanup();
    this.sink.closed({ error });
    // Whatever the socket does next is not reported: the close above already was.
    this.socket?.terminate();
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== undefined) {
      this.timer.clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }

  private cleanup(): void {
    this.clearHandshakeTimer();
    if (this.pingTimer !== undefined) {
      this.timer.clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    this.isOpen = false;
  }
}
