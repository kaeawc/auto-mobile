import type { Socket } from "node:net";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { deviceSessionErrorFields } from "../deviceSessionResolver";
import { streamAuthRefusalFields, type StreamSocketAuthenticator } from "../streamSocketAuth";
import type { SubscriptionResponse } from "../socketServer/index";
import type { OnStorageSubscriptionRequestedCallback } from "./streamContracts";

interface StorageReconciliationMessage {
  type: "storage_reconciliation_required";
  deviceId: string;
  packageName: string;
  fileName: string;
}

export interface StorageSubscriptionsHost {
  readonly authenticator: StreamSocketAuthenticator;
  resolveStorageTargetDeviceId(
    request: { deviceId?: string; deviceSessionUuid?: string },
    subscribe: boolean,
  ): string | null;
  sendJson(socket: Socket, message: SubscriptionResponse | StorageReconciliationMessage): void;
  recordSocketIdentity(socket: Socket, sessionUuid: string | undefined): void;
  endStaleIdentitySockets(): number;
}

/** One device-side observer, shared by every connected desktop stream that owns it. */
interface StorageSubscriptionState {
  deviceId: string | null;
  packageName: string;
  fileName: string;
  owners: Set<Socket>;
}

/** Owns shared device-side observers, desktop ownership, and ordered lifecycle operations. */
export class StorageSubscriptions {
  constructor(private readonly host: StorageSubscriptionsHost) {}

  private onStorageSubscriptionRequested: OnStorageSubscriptionRequestedCallback | null = null;
  /**
   * Storage observers are daemon-owned resources rather than one-command side effects. Track the
   * desktop sockets that own each observer so one pane closing cannot unsubscribe another pane,
   * and so a newly connected Android runner can restore all active observers.
   */
  private readonly storageSubscriptions = new Map<string, StorageSubscriptionState>();
  private readonly storageSubscriptionKeysBySocket = new Map<Socket, Set<string>>();
  /** Serializes lifecycle operations for one device-side storage observer. */
  private readonly storageOperations = new Map<string, Promise<void>>();

  /**
   * Set a callback to handle per-file storage (un)subscription requests, so the daemon can register
   * the device-side content observer that produces `storage_update` frames.
   */
  setOnStorageSubscriptionRequested(callback: OnStorageSubscriptionRequestedCallback): void {
    this.onStorageSubscriptionRequested = callback;
  }

  /**
   * Re-register every active observer for [deviceId] after its Android CtrlProxy reconnects.
   * A retained zero-owner entry instead retries its failed teardown. Desktop socket ownership
   * deliberately remains intact across that runner-only reconnect.
   */
  async reapplyStorageSubscriptionsForDevice(deviceId: string): Promise<void> {
    // A released session's storage observer must not be re-registered against the next holder.
    this.host.endStaleIdentitySockets();
    const subscriptions = [...this.storageSubscriptions.entries()].filter(
      ([, subscription]) => subscription.deviceId === deviceId,
    );
    for (const [key, subscription] of subscriptions) {
      try {
        await this.queueStorageOperation(key, {
          ...subscription,
          subscribe: subscription.owners.size > 0,
        });
        this.notifyStorageReconciliationRequired(deviceId, subscription);
        this.removeStorageSubscriptionIfUnowned(key, subscription);
      } catch (error) {
        logger.warn(
          `[DeviceDataStream] Failed to replay storage observer lifecycle for ${subscription.packageName}/${subscription.fileName}: ${errorMessage(error)}`,
        );
      }
    }
  }

  private notifyStorageReconciliationRequired(
    deviceId: string,
    subscription: StorageSubscriptionState,
  ): void {
    for (const owner of subscription.owners) {
      this.host.sendJson(owner, {
        type: "storage_reconciliation_required",
        deviceId,
        packageName: subscription.packageName,
        fileName: subscription.fileName,
      });
    }
  }

  private async subscribeStorageForSocket(
    socket: Socket,
    key: string,
    request: {
      deviceId: string | null;
      packageName: string;
      fileName: string;
      subscribe: boolean;
    },
  ): Promise<void> {
    const existing = this.storageSubscriptions.get(key);
    if (existing) {
      this.addStorageSubscriptionOwner(socket, key, existing);
      let registered = false;
      try {
        if (existing.owners.size === 1) {
          // A prior final-owner teardown failed and left a zero-owner tombstone. Queue a fresh
          // registration rather than treating the retained record as a live observer.
          await this.queueStorageOperation(key, request);
        } else {
          await this.storageOperations.get(key);
        }
        registered = true;
      } finally {
        // A failed registration never acquired an observer. Preserve its original rejection for
        // the request handler while removing the stale owner that would mask a later retry.
        if (!registered) {
          this.removeStorageSubscriptionOwner(socket, key, existing);
        }
      }
      return;
    }

    const subscription: StorageSubscriptionState = {
      deviceId: request.deviceId,
      packageName: request.packageName,
      fileName: request.fileName,
      owners: new Set(),
    };
    this.storageSubscriptions.set(key, subscription);
    this.addStorageSubscriptionOwner(socket, key, subscription);
    let registered = false;
    try {
      await this.queueStorageOperation(key, request);
      registered = true;
    } finally {
      if (!registered) {
        this.removeStorageSubscriptionOwner(socket, key, subscription);
      }
    }
  }

  private async unsubscribeStorageForSocket(
    socket: Socket,
    key: string,
    request: {
      deviceId: string | null;
      packageName: string;
      fileName: string;
      subscribe: boolean;
    },
  ): Promise<void> {
    const subscription = this.storageSubscriptions.get(key) ?? null;
    if (!subscription || !this.removeStorageSubscriptionOwner(socket, key, subscription)) {
      return;
    }
    if (subscription.owners.size === 0) {
      // Preserve a socket-owned tombstone while the final teardown is in flight. If CtrlProxy is
      // transiently unavailable, connection close or runner reconnect can retry it instead of
      // losing the only record of the device-side observer.
      this.retainStorageSubscriptionKeyForSocket(socket, key);
      await this.queueStorageOperation(key, request);
      this.forgetStorageSubscriptionKeyForSocket(socket, key);
      this.removeStorageSubscriptionIfUnowned(key, subscription);
    }
  }

  private addStorageSubscriptionOwner(
    socket: Socket,
    key: string,
    subscription: StorageSubscriptionState,
  ): void {
    if (!subscription.owners.add(socket)) {
      return;
    }
    this.retainStorageSubscriptionKeyForSocket(socket, key);
  }

  /**
   * Returns true only when [socket] actually owned the observer. The final owner removes the
   * record before awaiting teardown so a concurrent reconnect creates a new, ordered lifecycle.
   */
  private removeStorageSubscriptionOwner(
    socket: Socket,
    key: string,
    subscription: StorageSubscriptionState,
  ): boolean {
    if (!subscription.owners.delete(socket)) {
      return false;
    }
    this.forgetStorageSubscriptionKeyForSocket(socket, key);
    return true;
  }

  /** Release every observer owned by a desktop socket that disconnected without an explicit UI tear-down. */
  releaseStorageSubscriptionsForSocket(socket: Socket, retainForCloseRetry: boolean): void {
    const keys = this.storageSubscriptionKeysBySocket.get(socket);
    if (!keys) {
      return;
    }
    for (const key of [...keys]) {
      const subscription = this.storageSubscriptions.get(key);
      if (!subscription) {
        this.forgetStorageSubscriptionKeyForSocket(socket, key);
        continue;
      }
      this.removeStorageSubscriptionOwner(socket, key, subscription);
      if (subscription.owners.size === 0) {
        // An error event is normally followed by close, so preserve its key long enough for that
        // second callback to retry. A close callback is terminal and must not retain the dead
        // socket; the ownerless subscription itself remains as a runner-reconnect tombstone.
        if (retainForCloseRetry) {
          this.retainStorageSubscriptionKeyForSocket(socket, key);
        } else {
          this.forgetStorageSubscriptionKeyForSocket(socket, key);
        }
        void this.queueStorageOperation(key, { ...subscription, subscribe: false }).then(
          () => {
            this.removeStorageSubscriptionIfUnowned(key, subscription);
            this.forgetStorageSubscriptionKeyForSocket(socket, key);
          },
          (error) => {
            logger.warn(
              `[DeviceDataStream] Failed to release storage observer for ${subscription.packageName}/${subscription.fileName}: ${errorMessage(error)}`,
            );
            if (!retainForCloseRetry) {
              this.forgetStorageSubscriptionKeyForSocket(socket, key);
            }
          },
        );
      }
    }
  }

  private retainStorageSubscriptionKeyForSocket(socket: Socket, key: string): void {
    const keys = this.storageSubscriptionKeysBySocket.get(socket) ?? new Set<string>();
    keys.add(key);
    this.storageSubscriptionKeysBySocket.set(socket, keys);
  }

  private forgetStorageSubscriptionKeyForSocket(socket: Socket, key: string): void {
    const keys = this.storageSubscriptionKeysBySocket.get(socket);
    keys?.delete(key);
    if (keys?.size === 0) {
      this.storageSubscriptionKeysBySocket.delete(socket);
    }
  }

  private removeStorageSubscriptionIfUnowned(
    key: string,
    subscription: StorageSubscriptionState,
  ): void {
    if (subscription.owners.size === 0 && this.storageSubscriptions.get(key) === subscription) {
      this.storageSubscriptions.delete(key);
    }
  }

  /** Queue an observer operation behind any prior command for the same device/package/file. */
  private queueStorageOperation(
    key: string,
    request: {
      deviceId: string | null;
      packageName: string;
      fileName: string;
      subscribe: boolean;
    },
  ): Promise<void> {
    if (!this.onStorageSubscriptionRequested) {
      return Promise.resolve();
    }
    const previous = this.storageOperations.get(key) ?? Promise.resolve();
    // The prior request reports its own failure; either outcome admits the next ordered command.
    const operation = previous
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => this.onStorageSubscriptionRequested!(request));
    this.storageOperations.set(key, operation);
    // Cleanup observes both outcomes without replacing the rejection returned to the caller.
    void operation.then(
      () => this.clearStorageOperation(key, operation),
      () => this.clearStorageOperation(key, operation),
    );
    return operation;
  }

  /**
   * Register or release a device-side content observer for one key/value file, so
   * external writes to it emit `storage_update` frames. The acknowledgement follows
   * the device-side result, so the desktop can safely reconcile its snapshot after
   * registration.
   */
  async handleStorageSubscriptionRequest(
    socket: Socket,
    request: {
      id?: string;
      command: string;
      deviceId?: string;
      deviceSessionUuid?: string;
      sessionUuid?: string;
      packageName?: string;
      fileName?: string;
    },
  ): Promise<void> {
    const subscribe = request.command === "subscribe_storage";
    const { packageName, fileName } = request;
    if (!packageName || !fileName) {
      this.host.sendJson(socket, {
        id: request.id,
        type: "error",
        success: false,
        error: `${request.command} requires packageName and fileName`,
      } satisfies SubscriptionResponse);
      return;
    }

    let storageDeviceId: string | null;
    try {
      storageDeviceId = this.host.resolveStorageTargetDeviceId(request, subscribe);
      // Watching stored values is a read (#10830): a held device admits any live identity, as
      // the video viewer grant does (#10698). Writes stay owner-only through tools/call.
      this.host.authenticator.authorize({
        sessionUuid: request.sessionUuid,
        deviceId: storageDeviceId ?? undefined,
        admitViewer: true,
      });
    } catch (error) {
      this.host.sendJson(socket, {
        id: request.id,
        type: "error",
        success: false,
        error: errorMessage(error),
        ...streamAuthRefusalFields(error),
        ...deviceSessionErrorFields(error),
      } satisfies SubscriptionResponse);
      return;
    }

    // The CtrlProxy observer is keyed by serial/package/file, not by the session epoch. A
    // reconnecting pane receives a new session UUID for the same serial; keeping UUIDs in this
    // ownership key lets the retired pane's teardown unregister the refreshed pane's observer.
    if (subscribe) {
      this.host.recordSocketIdentity(socket, request.sessionUuid);
    }
    const key = `${storageDeviceId ?? "all"}:${packageName}:${fileName}`;
    const storageRequest = {
      deviceId: storageDeviceId,
      sessionUuid: request.sessionUuid,
      packageName,
      fileName,
      subscribe,
    };
    try {
      if (subscribe) {
        await this.subscribeStorageForSocket(socket, key, storageRequest);
      } else {
        await this.unsubscribeStorageForSocket(socket, key, storageRequest);
      }
    } catch (error) {
      logger.warn(
        `[DeviceDataStream] Error handling ${request.command} for ${packageName}/${fileName}: ${errorMessage(error)}`,
      );
      this.host.sendJson(socket, {
        id: request.id,
        type: "error",
        success: false,
        error: errorMessage(error),
        ...deviceSessionErrorFields(error),
      } satisfies SubscriptionResponse);
      return;
    }

    this.host.sendJson(socket, {
      id: request.id,
      type: "subscription_response",
      success: true,
    } satisfies SubscriptionResponse);
  }

  private clearStorageOperation(key: string, operation: Promise<void>): void {
    if (this.storageOperations.get(key) === operation) {
      this.storageOperations.delete(key);
    }
  }
}
