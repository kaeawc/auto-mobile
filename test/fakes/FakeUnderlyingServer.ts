import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

/** Request/notification surface used by resource registry tests. */
export class FakeUnderlyingServer implements Pick<Server, "notification"> {
  readonly notifications: Array<{ method: string; params?: unknown }> = [];
  readonly handlersBySchema = new Map<
    unknown,
    (request: unknown, extra?: unknown) => Promise<unknown>
  >();
  shouldThrow = false;
  notificationStarted?: () => void;
  notificationGate?: Promise<void>;
  onclose?: () => void;

  setRequestHandler(
    schema: unknown,
    handler: (request: unknown, extra?: unknown) => Promise<unknown>,
  ): void {
    this.handlersBySchema.set(schema, handler);
  }

  async notification(payload: Parameters<Server["notification"]>[0]): Promise<void> {
    if (this.shouldThrow) {
      throw new Error("Not connected");
    }
    this.notifications.push(payload);
    this.notificationStarted?.();
    await this.notificationGate;
  }
}
