import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { SessionBrokerDevicePort } from "./devicePort";
import type { SqliteSessionBrokerStore } from "./sqliteStore";
import { destructionTicket, type BrokerResourceRecord, type DestructionTicket } from "./store";

export interface SessionBrokerPoolDrainEntry {
  resourceId: string;
  outcome: "destroyed" | "cleanup_pending";
  cleanupPending: boolean;
}

export interface SessionBrokerPoolDrainResult {
  resources: SessionBrokerPoolDrainEntry[];
}

/**
 * Native destruction behind the durable destroying rows. Passes for one resource are shared, and
 * a destroy that is not yet absent keeps its row and journal for a later pass.
 */
export class DestructionQueue {
  private readonly destroys = new Map<string, Promise<void>>();
  private readonly drains = new Set<Promise<SessionBrokerPoolDrainResult>>();

  constructor(
    private readonly store: SqliteSessionBrokerStore,
    private readonly devices: SessionBrokerDevicePort,
  ) {}

  async destroy(resource: BrokerResourceRecord, signal?: AbortSignal): Promise<boolean> {
    if ((await this.devices.destroy(resource, signal)) !== "absent") {
      return false;
    }
    signal?.throwIfAborted();
    return this.store.confirmDestroyed(destructionTicket(resource));
  }

  tryCleanup(ticket: DestructionTicket, signal?: AbortSignal): Promise<void> {
    const previous = this.destroys.get(ticket.resourceId);
    if (previous) {
      return previous;
    }
    const pending = this.cleanupOnce(ticket, signal).finally(() => {
      this.destroys.delete(ticket.resourceId);
    });
    this.destroys.set(ticket.resourceId, pending);
    return pending;
  }

  /** Joins admitted drains and destroy passes; unfinished cleanup keeps its durable row. */
  async joinAll(): Promise<void> {
    while (this.drains.size > 0 || this.destroys.size > 0) {
      await Promise.allSettled([...this.drains, ...this.destroys.values()]);
    }
  }

  /**
   * Operator drain: every idle pooled resource enters the durable destroy journal in one
   * transaction, then each is destroyed through the same path acquisition eviction uses.
   * A replay finds only resources that are still idle, so a settled drain is a no-op.
   */
  drainIdlePool(): Promise<SessionBrokerPoolDrainResult> {
    const pending = this.drainIdlePoolOnce().finally(() => {
      this.drains.delete(pending);
    });
    this.drains.add(pending);
    return pending;
  }

  private async drainIdlePoolOnce(): Promise<SessionBrokerPoolDrainResult> {
    const resources: SessionBrokerPoolDrainEntry[] = [];
    for (const ticket of await this.store.drainIdle()) {
      await this.tryCleanup(ticket);
      const resource = await this.store.getResource(ticket.resourceId);
      // Only unreferenced destroyed tombstones are deleted, so a missing row confirms cleanup.
      const destroyed = !resource || resource.state === "destroyed";
      resources.push({
        resourceId: ticket.resourceId,
        outcome: destroyed ? "destroyed" : "cleanup_pending",
        cleanupPending: !destroyed,
      });
    }
    return { resources };
  }

  private async cleanupOnce(ticket: DestructionTicket, signal?: AbortSignal): Promise<void> {
    const resource = await this.store.getResource(ticket.resourceId);
    if (resource?.state === "destroying" && resource.revision === ticket.revision) {
      try {
        signal?.throwIfAborted();
        await this.destroy(resource, signal);
      } catch (error) {
        // The durable destroying row and native journal retain ownership for another pass.
        logger.warn(
          `Session resource ${resource.resourceId} cleanup remains pending: ${errorMessage(error)}`,
        );
      }
    }
  }
}
