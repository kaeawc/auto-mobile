import type {
  HandlerResultTypeMap,
  RequestTypeMap,
  Server,
  ServerContext,
} from "@modelcontextprotocol/server";
import type {
  RegistryUnderlyingServer,
  ResourceRegistryRequestMethod,
} from "../../src/server/registryHost";

/**
 * Stored handlers are called by tests with hand-built requests, so the stored
 * shape is deliberately loose. Method syntax keeps the parameter bivariant, which
 * lets each typed registry handler be stored without a cast.
 */
type StoredHandler = {
  call(request: unknown, extra?: unknown): unknown;
}["call"];

/** Request/notification surface used by resource registry tests. */
export class FakeUnderlyingServer
  implements Pick<Server, "notification">, RegistryUnderlyingServer
{
  readonly notifications: Array<{ method: string; params?: unknown }> = [];
  readonly handlersBySchema = new Map<unknown, StoredHandler>();
  shouldThrow = false;
  notificationStarted?: () => void;
  notificationGate?: Promise<void>;
  onclose?: () => void;

  setRequestHandler<M extends ResourceRegistryRequestMethod>(
    method: M,
    handler: (
      request: RequestTypeMap[M],
      ctx: ServerContext,
    ) => HandlerResultTypeMap[M] | Promise<HandlerResultTypeMap[M]>,
  ): void;
  setRequestHandler(method: string, handler: StoredHandler): void {
    this.handlersBySchema.set(method, handler);
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
