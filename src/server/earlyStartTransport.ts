import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";

type JSONRPCMessage = Parameters<Transport["send"]>[0];
type MessageExtraInfo = Parameters<NonNullable<Transport["onmessage"]>>[1];

/**
 * Starts an MCP transport before any server is connected to it, holding inbound messages until
 * one is (#11173).
 *
 * A managed slot proxy acquires its slots before it may answer `initialize` (the result is part of
 * the initialize capabilities), yet must still notice the client going away during that
 * acquisition: stdin EOF is only observed while stdin is being read. Starting the stdio transport
 * early keeps stdin read, so EOF reaches the process shutdown path (which aborts the acquisition),
 * while `initialize` and anything after it wait here, in order, for the server.
 */
export class EarlyStartTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  private readonly held: Array<{ message: JSONRPCMessage; extra?: MessageExtraInfo }> = [];
  private readonly heldErrors: Error[] = [];
  private innerStarted = false;
  private attached = false;
  private closedEarly = false;

  constructor(private readonly inner: Transport) {}

  /** Start reading now; messages are held until {@link start} (a server connecting). */
  async startEarly(): Promise<void> {
    if (this.innerStarted) {
      return;
    }
    this.innerStarted = true;
    this.inner.onmessage = (message, extra) => {
      if (this.attached && this.onmessage) {
        this.onmessage(message, extra);
      } else {
        this.held.push({ message, extra });
      }
    };
    this.inner.onerror = (error) => {
      if (this.attached && this.onerror) {
        this.onerror(error);
      } else {
        this.heldErrors.push(error);
      }
    };
    this.inner.onclose = () => {
      if (this.attached) {
        this.onclose?.();
      } else {
        this.closedEarly = true;
      }
    };
    await this.inner.start();
  }

  /** Called by the server's `connect`: deliver everything held, in arrival order, then stream. */
  async start(): Promise<void> {
    await this.startEarly();
    this.attached = true;
    for (const error of this.heldErrors.splice(0)) {
      this.onerror?.(error);
    }
    for (const { message, extra } of this.held.splice(0)) {
      this.onmessage?.(message, extra);
    }
    if (this.closedEarly) {
      this.onclose?.();
    }
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.inner.send(message, options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }
}
