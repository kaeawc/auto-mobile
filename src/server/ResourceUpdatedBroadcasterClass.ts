import type { ResourceUpdateTargets } from "./listChangedBroadcast";
import { logger } from "../utils/logger";

/** Process-wide resource changes for transports outside the registry's MCP sessions. */
export class ResourceUpdatedBroadcasterClass {
  private readonly listeners = new Set<(resolveTargets: ResourceUpdateTargets) => void>();

  subscribe(listener: (resolveTargets: ResourceUpdateTargets) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(resolveTargets: ResourceUpdateTargets): void {
    for (const listener of this.listeners) {
      try {
        listener(resolveTargets);
      } catch (error) {
        logger.warn("[ResourceUpdatedBroadcaster] resource update listener failed", error);
      }
    }
  }

  clearForTesting(): void {
    this.listeners.clear();
  }
}
