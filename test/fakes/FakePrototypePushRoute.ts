import type { PrototypePushPayload } from "../../src/features/prototype/prototypePush";
import type {
  PrototypePushReply,
  PrototypePushRoute,
} from "../../src/features/prototype/prototypePushSimulate";

/** A scripted push route that records every delivery. */
export class FakePrototypePushRoute implements PrototypePushRoute {
  readonly delivered: Array<{ id: string; payload: PrototypePushPayload; timeoutMs?: number }> = [];
  private failure: Error | undefined;

  constructor(
    private isAvailable = true,
    private reply: PrototypePushReply = { success: true, handled: true },
  ) {}

  setAvailable(available: boolean): void {
    this.isAvailable = available;
  }

  setReply(reply: PrototypePushReply): void {
    this.reply = reply;
  }

  failWith(error: Error): void {
    this.failure = error;
  }

  async available(): Promise<boolean> {
    return this.isAvailable;
  }

  async deliver(
    id: string,
    payload: PrototypePushPayload,
    timeoutMs?: number,
  ): Promise<PrototypePushReply> {
    this.delivered.push({ id, payload, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    if (this.failure) {
      throw this.failure;
    }
    return this.reply;
  }
}
