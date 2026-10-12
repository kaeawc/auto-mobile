import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import { logger } from "../utils/logger";

type JSONRPCMessage = Parameters<Transport["send"]>[0];

/** Keeps inbound transport behavior intact while silencing a disconnected stdio client's output. */
export class OutputGatedTransport implements Transport {
  private stoppedReason: string | undefined;

  constructor(
    private readonly inner: Transport,
    private readonly log: (message: string) => void = (message) => logger.debug(message),
  ) {}

  /** Idempotent and synchronous. After this, send resolves without calling inner.send. */
  stopSending(reason: string): void {
    this.stoppedReason ??= reason;
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if (this.stoppedReason !== undefined) {
      this.log(
        `[OutputGatedTransport] Dropped ${"method" in message ? message.method : "response"}: ${this.stoppedReason}`,
      );
      return Promise.resolve();
    }
    return this.inner.send(message, options);
  }

  start(): Promise<void> {
    return this.inner.start();
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

  get onmessage(): Transport["onmessage"] {
    return this.inner.onmessage;
  }

  set onmessage(callback: Transport["onmessage"]) {
    this.inner.onmessage = callback;
  }

  get onclose(): Transport["onclose"] {
    return this.inner.onclose;
  }

  set onclose(callback: Transport["onclose"]) {
    this.inner.onclose = callback;
  }

  get onerror(): Transport["onerror"] {
    return this.inner.onerror;
  }

  set onerror(callback: Transport["onerror"]) {
    this.inner.onerror = callback;
  }
}
