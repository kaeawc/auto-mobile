import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import { logger } from "../utils/logger";

type JSONRPCMessage = Parameters<Transport["send"]>[0];

/** Keeps inbound transport behavior intact while silencing a disconnected stdio client's output. */
export class OutputGatedTransport implements Transport {
  private stoppedReason: string | undefined;
  private answersOnlyReason: string | undefined;
  private readonly receivedRequestIds = new Set<string | number>();
  private pendingAnswerWrites = 0;
  private messageCallback: Transport["onmessage"];
  private answerWait: ReturnType<typeof Promise.withResolvers<void>> | undefined;

  constructor(
    private readonly inner: Transport,
    private readonly log: (message: string) => void = (message) => logger.debug(message),
  ) {}

  /** Idempotent and synchronous. After this, send resolves without calling inner.send. */
  stopSending(reason: string): void {
    this.stoppedReason ??= reason;
    this.answerWait?.resolve();
  }

  /** Switch synchronously to received answers only, then stop after their writes settle. */
  answerReceivedThenStop(reason: string): Promise<void> {
    if (!this.answerWait) {
      this.answerWait = Promise.withResolvers<void>();
      this.answersOnlyReason = reason;
      this.stopIfAnswered();
    }
    return this.answerWait.promise;
  }

  private stopIfAnswered(): void {
    if (this.stoppedReason !== undefined) {
      this.answerWait?.resolve();
    } else if (
      this.answersOnlyReason !== undefined &&
      this.receivedRequestIds.size === 0 &&
      this.pendingAnswerWrites === 0
    ) {
      this.stopSending(this.answersOnlyReason);
    }
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const responseId = !("method" in message) && "id" in message ? message.id : undefined;
    const dropReason =
      this.stoppedReason ??
      (this.answersOnlyReason !== undefined &&
      (responseId === undefined || !this.receivedRequestIds.has(responseId))
        ? this.answersOnlyReason
        : undefined);
    if (dropReason !== undefined) {
      this.log(
        `[OutputGatedTransport] Dropped ${"method" in message ? message.method : "response"}: ${dropReason}`,
      );
      return;
    }
    if (responseId === undefined) {
      return this.inner.send(message, options);
    }
    this.pendingAnswerWrites++;
    try {
      await this.inner.send(message, options);
    } finally {
      this.receivedRequestIds.delete(responseId);
      this.pendingAnswerWrites--;
      this.stopIfAnswered();
    }
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
    return this.messageCallback;
  }

  set onmessage(callback: Transport["onmessage"]) {
    this.messageCallback = callback;
    this.inner.onmessage = (message, extra) => {
      if ("method" in message && "id" in message) {
        this.receivedRequestIds.add(message.id);
      } else if ("method" in message && message.method === "notifications/cancelled") {
        const requestId = message.params?.requestId;
        if (typeof requestId === "string" || typeof requestId === "number") {
          this.receivedRequestIds.delete(requestId);
          this.stopIfAnswered();
        }
      }
      callback?.(message, extra);
    };
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
