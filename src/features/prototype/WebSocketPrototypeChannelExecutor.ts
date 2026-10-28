/**
 * WebSocket transport for host-proxied prototype channels (#14268): one `PrototypeWebSocketChannel`
 * per `open`, connecting through the egress-validated address.
 */
import {
  onceClosedSink,
  type PrototypeChannelExecutor,
  type PrototypeChannelHandle,
  type PrototypeChannelOpenRequest,
  type PrototypeChannelSink,
  type PrototypeChannelTimer,
} from "./PrototypeChannelExecutor";
import {
  createWsPrototypeSocket,
  PrototypeWebSocketChannel,
  type PrototypeSocketFactory,
} from "./PrototypeWebSocketChannel";
import { systemHostResolver } from "./prototypeDestinationPinning";
import { prototypeDaemonPorts } from "./prototypeDaemonPorts";
import { StrictEgressPolicy, type EgressPolicy, type HostResolver } from "./prototypeEgressPolicy";

export interface WebSocketPrototypeChannelExecutorOptions {
  timer: PrototypeChannelTimer;
  socketFactory?: PrototypeSocketFactory;
  policy?: EgressPolicy;
  resolver?: HostResolver;
}

export class WebSocketPrototypeChannelExecutor implements PrototypeChannelExecutor {
  private readonly policy: EgressPolicy;
  private readonly resolver: HostResolver;
  private readonly socketFactory: PrototypeSocketFactory;

  constructor(private readonly options: WebSocketPrototypeChannelExecutorOptions) {
    this.policy = options.policy ?? new StrictEgressPolicy(prototypeDaemonPorts);
    this.resolver = options.resolver ?? systemHostResolver;
    this.socketFactory = options.socketFactory ?? createWsPrototypeSocket;
  }

  open(
    request: PrototypeChannelOpenRequest,
    sink: PrototypeChannelSink,
    signal: AbortSignal,
  ): PrototypeChannelHandle {
    const channel = new PrototypeWebSocketChannel(
      request,
      onceClosedSink(sink),
      signal,
      this.options.timer,
      this.socketFactory,
      { policy: this.policy, resolver: this.resolver, timer: this.options.timer },
    );
    void channel.start();
    return channel;
  }
}
