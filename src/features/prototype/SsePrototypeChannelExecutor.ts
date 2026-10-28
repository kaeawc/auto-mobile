/**
 * Server-sent-events transport for host-proxied prototype channels (#14268). The stream is read
 * through the pinned fetch, so every redirect hop is re-validated like a request. Events are cut
 * by `SseParser`; the device owns reconnect and sends the last event id back in `lastEventId`.
 */
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  channelProblemOf,
  onceClosedSink,
  type PrototypeChannelExecutor,
  type PrototypeChannelHandle,
  type PrototypeChannelOpenRequest,
  type PrototypeChannelSink,
  type PrototypeChannelTimer,
} from "./PrototypeChannelExecutor";
import type { PrototypeFetch } from "./PrototypeHttpExecutor";
import { MAX_PROTOTYPE_CHANNEL_FRAME_BYTES } from "./prototypeChannelLimits";
import type { PrototypeChannelError } from "./prototypeChannelProtocol";
import {
  pinPrototypeDestination,
  systemHostResolver,
  type PrototypeDestinationPinning,
} from "./prototypeDestinationPinning";
import { StrictEgressPolicy, type EgressPolicy, type HostResolver } from "./prototypeEgressPolicy";
import { prototypeDaemonPorts } from "./prototypeDaemonPorts";
import { pinnedPrototypeFetch, PrototypeResponseTooLargeError } from "./prototypePinnedTransport";
import { DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS } from "./prototypeRequestLimits";
import { SseParser } from "./prototypeSseParser";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;
/** A stream has no total size; only each event is bounded. */
const UNBOUNDED_STREAM_BYTES = Number.MAX_SAFE_INTEGER;
/** `data: `, the longest prefix of a line that can carry an event's data. */
const SSE_FIELD_PREFIX_CHARS = 6;

export interface SsePrototypeChannelExecutorOptions {
  timer: PrototypeChannelTimer;
  fetch?: PrototypeFetch;
  policy?: EgressPolicy;
  resolver?: HostResolver;
}

export class SsePrototypeChannelExecutor implements PrototypeChannelExecutor {
  private readonly pinning: PrototypeDestinationPinning;
  private readonly fetchImpl: PrototypeFetch;

  constructor(private readonly options: SsePrototypeChannelExecutorOptions) {
    this.fetchImpl = options.fetch ?? pinnedPrototypeFetch;
    this.pinning = {
      policy: options.policy ?? new StrictEgressPolicy(prototypeDaemonPorts),
      resolver: options.resolver ?? systemHostResolver,
      timer: options.timer,
    };
  }

  open(
    request: PrototypeChannelOpenRequest,
    sink: PrototypeChannelSink,
    signal: AbortSignal,
  ): PrototypeChannelHandle {
    const guarded = onceClosedSink(sink);
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    signal.addEventListener("abort", () => guarded.silence(), { once: true });
    void this.run(request, guarded.sink, combined, controller);
    return {
      send: () => ({ ok: false, reason: "unsupported" }),
      close: (code, reason) => {
        guarded.sink.closed({
          ...(code === undefined ? {} : { code }),
          ...(reason === undefined ? {} : { reason }),
        });
        controller.abort();
      },
    };
  }

  private async run(
    request: PrototypeChannelOpenRequest,
    sink: PrototypeChannelSink,
    signal: AbortSignal,
    controller: AbortController,
  ): Promise<void> {
    const problem = channelProblemOf(request);
    if (problem !== undefined) {
      sink.closed({ error: problem });
      return;
    }
    let timedOut = false;
    const handshake = this.options.timer.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS);
    try {
      const response = await this.connect(request, signal);
      this.options.timer.clearTimeout(handshake);
      if ("code" in response) {
        sink.closed({ error: response });
        return;
      }
      sink.opened();
      await this.pump(response, request, sink, signal);
      sink.closed({});
    } catch (error) {
      this.options.timer.clearTimeout(handshake);
      if (signal.aborted && !timedOut) {
        return;
      }
      sink.closed({ error: this.failureOf(error, timedOut) });
    }
  }

  private failureOf(error: unknown, timedOut: boolean): PrototypeChannelError {
    if (timedOut) {
      return { code: "timeout", message: "The event stream handshake timed out." };
    }
    if (error instanceof PrototypeResponseTooLargeError) {
      return {
        code: "too_large",
        message: `An event exceeded ${MAX_PROTOTYPE_CHANNEL_FRAME_BYTES} bytes.`,
      };
    }
    logger.warn(`[PrototypeChannel] event stream failed: ${errorMessage(error)}`);
    const record = error as { code?: unknown; cause?: { code?: unknown } } | null;
    return (record?.code ?? record?.cause?.code) === "ECONNREFUSED"
      ? { code: "connection_refused", message: "Connection refused." }
      : { code: "network", message: "The event stream failed." };
  }

  /** Follows redirects, re-pinning each hop, until a stream answers or the connection is refused. */
  private async connect(
    request: PrototypeChannelOpenRequest,
    signal: AbortSignal,
  ): Promise<Response | PrototypeChannelError> {
    let url = new URL(request.url);
    let headers = this.requestHeaders(request, request.headers);
    for (let hop = 0; ; hop++) {
      signal.throwIfAborted();
      const pinned = await pinPrototypeDestination(url, this.pinning, signal);
      if ("code" in pinned) {
        return pinned;
      }
      const response = await this.fetchImpl(
        url.href,
        { method: "GET", headers, signal, redirect: "manual" },
        pinned,
        UNBOUNDED_STREAM_BYTES,
      );
      if (!REDIRECT_STATUSES.has(response.status)) {
        return this.acceptStream(response);
      }
      await response.body?.cancel();
      const next = redirectTarget(response, url);
      if (hop === MAX_REDIRECT_HOPS || next === undefined) {
        return { code: "network", message: "Too many redirects or an invalid redirect." };
      }
      if (url.protocol === "https:" && next.protocol === "http:") {
        return {
          code: "blocked_destination",
          message: "The destination is not permitted: scheme downgrade.",
        };
      }
      // Authored headers may carry credentials; a cross-origin hop gets only the stream headers.
      if (url.origin !== next.origin) {
        headers = this.requestHeaders(request, undefined);
      }
      url = next;
    }
  }

  private requestHeaders(
    request: PrototypeChannelOpenRequest,
    authored: Record<string, string> | undefined,
  ): Record<string, string> {
    return {
      ...authored,
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      ...(request.lastEventId === undefined ? {} : { "Last-Event-ID": request.lastEventId }),
    };
  }

  private async acceptStream(response: Response): Promise<Response | PrototypeChannelError> {
    const contentType = response.headers.get("content-type") ?? "";
    if (response.status === 200 && contentType.toLowerCase().startsWith("text/event-stream")) {
      return response;
    }
    await response.body?.cancel();
    return {
      code: "handshake_failed",
      message:
        response.status === 200
          ? "The server did not answer with text/event-stream."
          : `The server answered the event stream with HTTP ${response.status}.`,
      status: response.status,
    };
  }

  private async pump(
    response: Response,
    request: PrototypeChannelOpenRequest,
    sink: PrototypeChannelSink,
    signal: AbortSignal,
  ): Promise<void> {
    if (response.body === null) {
      return;
    }
    const parser = new SseParser({
      onEvent: (event) => {
        const eventBytes =
          Buffer.byteLength(event.data) +
          Buffer.byteLength(event.event ?? "") +
          Buffer.byteLength(event.id ?? "");
        if (eventBytes > MAX_PROTOTYPE_CHANNEL_FRAME_BYTES) {
          throw new PrototypeResponseTooLargeError();
        }
        sink.frame(event);
      },
    });
    if (request.lastEventId !== undefined) {
      parser.seedLastEventId(request.lastEventId);
    }
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    // A read parked on a quiet stream ends when the connection is cancelled or closed.
    const stop = () => void reader.cancel().catch(() => undefined);
    signal.addEventListener("abort", stop, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        parser.push(decoder.decode(value, { stream: true }));
        // Characters never exceed bytes, so more characters than the cap is surely over it. The
        // line still arriving carries its field name, which is not part of the event's data.
        if (parser.pendingChars > MAX_PROTOTYPE_CHANNEL_FRAME_BYTES + SSE_FIELD_PREFIX_CHARS) {
          throw new PrototypeResponseTooLargeError();
        }
      }
    } finally {
      signal.removeEventListener("abort", stop);
      await reader.cancel().catch((error: unknown) => {
        // The stream is being abandoned; a failed cancel leaves nothing to clean up.
        logger.debug(`[PrototypeChannel] event stream cancel failed: ${errorMessage(error)}`);
      });
    }
  }
}

function redirectTarget(response: Response, base: URL): URL | undefined {
  const location = response.headers.get("location");
  if (!location) {
    return undefined;
  }
  try {
    return new URL(location, base);
  } catch (error) {
    // An invalid Location is an expected response shape, reported as a failed handshake.
    logger.debug("[PrototypeChannel] redirect URL parse failed.");
    return undefined;
  }
}
