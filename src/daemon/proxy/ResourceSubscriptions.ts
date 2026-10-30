import { errorMessage } from "../../utils/describeUnknownError";
import { DaemonUnavailableError, type DaemonClientLike } from "../client/client";
import { logger } from "../../utils/logger";
import {
  RESOURCE_SUBSCRIBE_METHOD,
  RESOURCE_UNSUBSCRIBE_METHOD,
  type DaemonNotification,
} from "../types";
import { toActionableError } from "../../models";
import { McpTimeoutError } from "../wire/McpTimeoutError";

function isPermanentResourceSubscriptionRejection(error: unknown): boolean {
  if (error instanceof McpTimeoutError || error instanceof DaemonUnavailableError) {
    return false;
  }
  if (error !== null && typeof error === "object" && "code" in error && error.code !== undefined) {
    return error.code === -32601 || error.code === -32602;
  }
  // These daemon responses currently carry only text, not a structured rejection code.
  const message = errorMessage(error);
  return (
    message.startsWith("Unsupported daemon method: resources/subscribe") ||
    message === "Resource subscription requires params.uri"
  );
}

export interface ResourceSubscriptionsDependencies {
  readonly client: DaemonClientLike | null;
  readonly connected: boolean;
  readonly closing: boolean;
  throwIfClosing(): void;
  connectResourceSubscriptionsInBackground(): void;
  assertConnectedClient(client: DaemonClientLike): void;
}

export class ResourceSubscriptions {
  readonly resourceSubscriptions = new Set<string>();
  readonly resourceUpdatedListeners = new Set<(uri: string) => void>();
  resourceSubscriptionSync: Promise<void> = Promise.resolve();
  constructor(private readonly deps: ResourceSubscriptionsDependencies) {}
  onResourceUpdated(listener: (uri: string) => void): () => void {
    this.resourceUpdatedListeners.add(listener);
    return () => {
      this.resourceUpdatedListeners.delete(listener);
    };
  }

  async subscribeResource(uri: string): Promise<void> {
    this.deps.throwIfClosing();
    this.resourceSubscriptions.add(uri);
    if (this.deps.connected) {
      try {
        await this.syncResourceSubscription(uri);
      } catch (error) {
        this.resourceSubscriptions.delete(uri);
        throw toActionableError(error, "Failed to subscribe to resource");
      }
    } else {
      this.deps.connectResourceSubscriptionsInBackground();
    }
  }

  async unsubscribeResource(uri: string): Promise<void> {
    this.deps.throwIfClosing();
    this.resourceSubscriptions.delete(uri);
    if (this.deps.connected) {
      await this.syncResourceSubscription(uri);
    }
  }

  async replayResourceSubscriptions(client: DaemonClientLike): Promise<void> {
    for (const uri of this.resourceSubscriptions) {
      try {
        await this.syncResourceSubscription(uri);
      } catch (error) {
        // Resource subscriptions are optional; rejection must not disable unrelated requests.
        logger.warn(`[DaemonMcpProxy] Failed to replay resource subscription ${uri}`, error);
        if (isPermanentResourceSubscriptionRejection(error)) {
          this.resourceSubscriptions.delete(uri);
        }
      }
    }
    this.deps.throwIfClosing();
    this.deps.assertConnectedClient(client);
  }

  syncResourceSubscription(uri: string): Promise<void> {
    const client = this.deps.client;
    const operation = this.resourceSubscriptionSync.then(async () => {
      if (!client || this.deps.client !== client || this.deps.closing) {
        return;
      }
      const method = this.resourceSubscriptions.has(uri)
        ? RESOURCE_SUBSCRIBE_METHOD
        : RESOURCE_UNSUBSCRIBE_METHOD;
      await client.callDaemonMethod(method, { uri });
    });
    // Keep subsequent mutations/replay ordered even after a failed RPC; its caller still rejects.
    this.resourceSubscriptionSync = operation.catch((error) => {
      logger.warn("[DaemonMcpProxy] Failed to synchronize resource subscription", error);
    });
    return operation;
  }

  handleResourceUpdated(notification: DaemonNotification, sourceClient: DaemonClientLike): void {
    const uri = notification.uri;
    if (sourceClient !== this.deps.client || !uri || !this.resourceSubscriptions.has(uri)) {
      return;
    }
    for (const listener of this.resourceUpdatedListeners) {
      try {
        listener(uri);
      } catch (error) {
        logger.warn("[DaemonMcpProxy] resource update listener failed", error);
      }
    }
  }
}
