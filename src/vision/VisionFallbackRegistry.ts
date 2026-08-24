/**
 * Keeps `VisionFallback` orchestrators alive across tool calls.
 *
 * `VisionFallback` owns its result cache as an instance field. Every production
 * consumer of vision fallback (TapOnElement, SwipeOn, DragAndDrop, PinchOn) is
 * constructed per tool call and reaches vision through `getVisionEnrichedError`,
 * so constructing the orchestrator there threw the cache away before it could
 * ever be read a second time — `cacheResults` and `cacheTtlMinutes` were dead
 * configuration and every fallback was a fresh paid analyzer call.
 *
 * The orchestrator is therefore memoized here, keyed by its configuration, so
 * the cache lifetime is the process rather than the call. Keying by config
 * means a changed provider or TTL gets its own cache instead of silently
 * reusing entries produced under different settings.
 */

import { VisionFallback } from "./VisionFallback";
import type { VisionFallbackConfig } from "./VisionTypes";
import { stableStringify } from "../utils/stableStringify";

export type VisionFallbackFactory = (config: VisionFallbackConfig) => VisionFallback;

const defaultFactory: VisionFallbackFactory = (config) => new VisionFallback(config);

/**
 * Distinct configs in a single process are few (config is effectively static
 * per install), so this only guards against an unbounded map if a caller ever
 * synthesizes configs per call.
 */
export const MAX_VISION_FALLBACK_INSTANCES = 8;

export class VisionFallbackRegistry {
  private instances = new Map<string, VisionFallback>();
  private createFallback: VisionFallbackFactory;

  constructor(createFallback: VisionFallbackFactory = defaultFactory) {
    this.createFallback = createFallback;
  }

  /**
   * Returns the orchestrator for this config, constructing it on first use.
   * Repeat calls with an equivalent config get the same instance — and so the
   * same result cache.
   */
  get(config: VisionFallbackConfig): VisionFallback {
    const key = stableStringify(config);
    const existing = this.instances.get(key);
    if (existing) {
      return existing;
    }

    const created = this.createFallback(config);
    this.instances.set(key, created);

    // Map iteration order is insertion order: evict oldest-created first.
    while (this.instances.size > MAX_VISION_FALLBACK_INSTANCES) {
      const oldest = this.instances.keys().next();
      if (oldest.done) {
        break;
      }
      this.instances.delete(oldest.value);
    }

    return created;
  }

  clear(): void {
    this.instances.clear();
  }

  get size(): number {
    return this.instances.size;
  }
}

let sharedRegistry = new VisionFallbackRegistry();

/** The process-wide registry used by `getVisionEnrichedError`. */
export function getSharedVisionFallback(config: VisionFallbackConfig): VisionFallback {
  return sharedRegistry.get(config);
}

/**
 * Swap the process-wide registry. Tests use this to supply a registry whose
 * factory builds a real `VisionFallback` around a counting stub client, so the
 * caching path is exercised for real without a paid call. Passing null restores
 * the default registry.
 */
export function setSharedVisionFallbackRegistry(registry: VisionFallbackRegistry | null): void {
  sharedRegistry = registry ?? new VisionFallbackRegistry();
}
