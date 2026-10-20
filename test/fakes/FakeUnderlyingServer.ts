import type {
  HandlerResultTypeMap,
  RequestTypeMap,
  Server,
  ServerNotification,
  ServerContext,
} from "@modelcontextprotocol/server";
import type {
  RegistryUnderlyingServer,
  ResourceRegistryRequestMethod,
} from "../../src/server/registryHost";

/**
 * Method syntax keeps the parameters bivariant, so each typed registry handler
 * is accepted here without a cast; tests then call the stored wrapper with
 * hand-built requests.
 */
type LooseHandler = {
  call(request: unknown, extra?: unknown): unknown;
}["call"];

/** Request/notification surface used by resource registry tests. */
export class FakeUnderlyingServer
  implements Pick<Server, "notification">, RegistryUnderlyingServer
{
  readonly notifications: Array<{ method: string; params?: unknown }> = [];
  readonly handlersBySchema = new Map<
    unknown,
    (request: unknown, extra?: unknown) => Promise<unknown>
  >();
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
  ): void {
    const loose: LooseHandler = handler;
    this.handlersBySchema.set(method, async (request, extra) => loose(request, extra));
  }

  async notification(payload: ServerNotification): Promise<void> {
    if (this.shouldThrow) {
      throw new Error("Not connected");
    }
    this.notifications.push(payload);
    this.notificationStarted?.();
    await this.notificationGate;
  }
}
