/**
 * Routes reserved mock origins before any channel transport can reach DNS or a socket, and serves
 * them from the mock backend's rooms (#14271).
 */
import {
  channelProblemOf,
  onceClosedSink,
  type PrototypeChannelExecutor,
  type PrototypeChannelHandle,
  type PrototypeChannelOpenRequest,
  type PrototypeChannelSink,
} from "./PrototypeChannelExecutor";
import type { PrototypeMockBackend } from "./PrototypeMockBackend";
import type { PrototypeMockBackendRegistry } from "./PrototypeMockBackendRegistry";
import { MAX_PROTOTYPE_CHANNEL_SEND_BYTES } from "./prototypeChannelLimits";
import { mockTargetOf, type MockTarget } from "./prototypeMockOrigin";

const CLOSED_HANDLE: PrototypeChannelHandle = {
  send: () => ({ ok: false, reason: "not_open" }),
  close: () => {},
};

export class MockRoutingPrototypeChannelExecutor implements PrototypeChannelExecutor {
  constructor(
    private readonly inner: PrototypeChannelExecutor,
    private readonly registry: Pick<PrototypeMockBackendRegistry, "get">,
  ) {}

  open(
    request: PrototypeChannelOpenRequest,
    sink: PrototypeChannelSink,
    signal: AbortSignal,
  ): PrototypeChannelHandle {
    if (signal.aborted) {
      return CLOSED_HANDLE;
    }
    const target = channelMockTargetOf(request.url);
    if (target === undefined) {
      return this.inner.open(request, sink, signal);
    }
    const problem = channelProblemOf(request);
    if (problem !== undefined) {
      sink.closed({ error: problem });
      return CLOSED_HANDLE;
    }
    const backend = this.registry.get(target.backendId);
    if (backend === undefined) {
      sink.closed({
        error: { code: "network", message: `No mock backend "${target.backendId}" is defined.` },
      });
      return CLOSED_HANDLE;
    }
    return openMockChannel({ backend, request, target }, sink, signal);
  }
}

/** The shared mock-origin helper accepts HTTP(S); WS(S) addresses the same reserved hosts. */
function channelMockTargetOf(raw: string): MockTarget | undefined {
  const url = URL.canParse(raw) ? new URL(raw) : undefined;
  if (url?.protocol === "ws:" || url?.protocol === "wss:") {
    url.protocol = url.protocol === "ws:" ? "http:" : "https:";
  }
  return mockTargetOf(url?.href ?? raw);
}

/**
 * Joins the room the URL names. A path no room matches is refused like a server answering 404, and
 * a full room like 503. Aborting `signal` leaves silently; a close from the device is acknowledged
 * with the same code, as a server echoing the close frame would.
 */
function openMockChannel(
  {
    backend,
    request,
    target,
  }: { backend: PrototypeMockBackend; request: PrototypeChannelOpenRequest; target: MockTarget },
  outer: PrototypeChannelSink,
  signal: AbortSignal,
): PrototypeChannelHandle {
  const { sink, silence } = onceClosedSink(outer);
  // onConnect frames arrive while joining, before the open can be reported: hold them until then.
  let pending: string[] | undefined = [];
  const joined = backend.join(target.path, target.query, {
    deliver: (data) => (pending === undefined ? sink.frame({ data }) : pending.push(data)),
    close: (code, reason) => sink.closed(request.kind === "websocket" ? { code, reason } : {}),
  });
  if (!joined.ok) {
    sink.closed({
      error: { code: "handshake_failed", message: joined.message, status: joined.status },
    });
    return CLOSED_HANDLE;
  }
  const { connection } = joined;
  sink.opened(request.kind === "websocket" ? request.protocols?.[0] : undefined);
  const greeting = pending;
  pending = undefined;
  greeting.forEach((data) => sink.frame({ data }));
  signal.addEventListener(
    "abort",
    () => {
      connection.leave();
      silence();
    },
    { once: true },
  );
  return {
    send: (data) => {
      if (request.kind !== "websocket") {
        return { ok: false, reason: "unsupported" };
      }
      if (Buffer.byteLength(data) > MAX_PROTOTYPE_CHANNEL_SEND_BYTES) {
        return { ok: false, reason: "too_large" };
      }
      return connection.send(data);
    },
    close: (code, reason) => {
      connection.leave();
      sink.closed({ code: code ?? 1000, ...(reason === undefined ? {} : { reason }) });
    },
  };
}
