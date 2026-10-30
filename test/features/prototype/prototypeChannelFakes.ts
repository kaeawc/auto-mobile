import type {
  PrototypeChannelClose,
  PrototypeChannelFrame,
  PrototypeChannelSink,
} from "../../../src/features/prototype/PrototypeChannelExecutor";
import type {
  PrototypeSocket,
  PrototypeSocketConnect,
  PrototypeSocketEvents,
  PrototypeSocketFactory,
} from "../../../src/features/prototype/PrototypeWebSocketChannel";

/** A socket whose server side the test drives through `events`. */
export class FakeSocket implements PrototypeSocket {
  readonly sent: string[] = [];
  pings = 0;
  closes: { code?: number; reason?: string }[] = [];
  terminated = false;
  constructor(
    readonly connect: PrototypeSocketConnect,
    readonly events: PrototypeSocketEvents,
  ) {}
  send(data: string): void {
    this.sent.push(data);
  }
  ping(): void {
    this.pings++;
  }
  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }
  terminate(): void {
    this.terminated = true;
  }
}

export class FakeSocketFactory {
  readonly sockets: FakeSocket[] = [];
  readonly factory: PrototypeSocketFactory = (connect, events) => {
    const socket = new FakeSocket(connect, events);
    this.sockets.push(socket);
    return socket;
  };
  get last(): FakeSocket {
    return this.sockets[this.sockets.length - 1]!;
  }
}

export class RecordingSink implements PrototypeChannelSink {
  readonly log: string[] = [];
  readonly frames: PrototypeChannelFrame[] = [];
  readonly closes: PrototypeChannelClose[] = [];
  opens: (string | undefined)[] = [];
  opened(protocol?: string): void {
    this.log.push("opened");
    this.opens.push(protocol);
  }
  frame(frame: PrototypeChannelFrame): void {
    this.log.push("frame");
    this.frames.push(frame);
  }
  closed(close: PrototypeChannelClose): void {
    this.log.push("closed");
    this.closes.push(close);
  }
}

/** Lets the executor's async start (resolve, pin) reach the socket factory. */
export const settle = async (): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    await Promise.resolve();
  }
};
