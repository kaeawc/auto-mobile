import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { DestructionQueue, SessionBrokerPoolDrainResult } from "./destructionQueue";
import { nativeProfile } from "./profile";
import type { SqliteSessionBrokerStore } from "./sqliteStore";
import { destructionTicket, type BrokerResourceRecord, type DestructionTicket } from "./store";

/**
 * Per-platform idle time-to-live; an omitted platform keeps idle devices until evicted. An Apple
 * Watch simulator follows the iOS simulator entry (#15882).
 */
export type IdlePoolTtlMs = Partial<Record<"ios" | "android", number>>;

interface IdleObservation {
  revision: number;
  idleSinceMs: number;
}

/**
 * Evicts pooled devices that stayed idle longer than their platform's TTL (#14364).
 *
 * The idle clock is in memory, keyed by the resource's revision: it starts at the first pass
 * that sees an idle revision, so reuse (which bumps the revision) restarts it, and a daemon
 * restart restarts every clock rather than trusting a persisted timestamp. Expiry goes through
 * the store's revision fence and then the operator drain's destroy path.
 */
export class IdlePoolExpiry {
  private readonly observed = new Map<string, IdleObservation>();

  constructor(
    private readonly ttlMs: IdlePoolTtlMs,
    private readonly store: Pick<SqliteSessionBrokerStore, "listLiveResources">,
    private readonly destructions: Pick<DestructionQueue, "expireIdle">,
    private readonly now: () => number,
  ) {}

  get enabled(): boolean {
    return this.ttlMs.ios !== undefined || this.ttlMs.android !== undefined;
  }

  async sweep(): Promise<SessionBrokerPoolDrainResult> {
    if (!this.enabled) {
      return { resources: [] };
    }
    const now = this.now();
    const idle = (await this.store.listLiveResources()).filter(
      (resource) => resource.state === "idle",
    );
    const expired: DestructionTicket[] = [];
    const seen = new Set<string>();
    for (const resource of idle) {
      const ttl = this.ttlFor(resource);
      if (ttl === undefined) {
        continue;
      }
      seen.add(resource.resourceId);
      const previous = this.observed.get(resource.resourceId);
      if (!previous || previous.revision !== resource.revision) {
        this.observed.set(resource.resourceId, { revision: resource.revision, idleSinceMs: now });
      } else if (now - previous.idleSinceMs >= ttl) {
        expired.push(destructionTicket(resource));
      }
    }
    for (const resourceId of [...this.observed.keys()]) {
      if (!seen.has(resourceId)) {
        this.observed.delete(resourceId);
      }
    }
    if (expired.length === 0) {
      return { resources: [] };
    }
    for (const ticket of expired) {
      this.observed.delete(ticket.resourceId);
    }
    const result = await this.destructions.expireIdle(expired);
    if (result.resources.length > 0) {
      logger.info(
        `Session broker expired ${result.resources.length} idle pooled device(s): ${result.resources
          .map((entry) => `${entry.resourceId} ${entry.outcome}`)
          .join(", ")}`,
      );
    }
    return result;
  }

  private ttlFor(resource: BrokerResourceRecord): number | undefined {
    try {
      const platform = nativeProfile(resource).platform;
      return this.ttlMs[platform === "watchos" ? "ios" : platform];
    } catch (error) {
      // A damaged profile is never expired here; recovery owns that resource's reservation.
      logger.warn(
        `Idle expiry skipped session resource ${resource.resourceId}: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }
}
