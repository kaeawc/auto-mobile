/** Routes reserved mock origins before any channel transport can reach DNS or a socket. */
import type {
  PrototypeChannelExecutor,
  PrototypeChannelHandle,
  PrototypeChannelOpenRequest,
  PrototypeChannelSink,
} from "./PrototypeChannelExecutor";
import type { PrototypeMockBackendRegistry } from "./PrototypeMockBackendRegistry";
import { mockTargetOf } from "./prototypeMockOrigin";

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
    // The shared mock-origin helper accepts HTTP(S); WS(S) addresses the same reserved hosts.
    const url = URL.canParse(request.url) ? new URL(request.url) : undefined;
    if (url?.protocol === "ws:" || url?.protocol === "wss:") {
      url.protocol = url.protocol === "ws:" ? "http:" : "https:";
    }
    const target = mockTargetOf(url?.href ?? request.url);
    if (target === undefined) {
      return this.inner.open(request, sink, signal);
    }
    const backend = this.registry.get(target.backendId);
    sink.closed({
      error: {
        code: "network",
        message:
          backend === undefined
            ? `No mock backend "${target.backendId}" is defined.`
            : `Mock backend "${target.backendId}" has no channel support yet.`,
      },
    });
    return CLOSED_HANDLE;
  }
}
