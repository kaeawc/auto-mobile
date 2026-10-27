import type { ControllerVersionMemory } from "./NetworkFilterBridge";

export const NETWORK_FILTER_LEGACY_MEMORY_TTL_MS = 60_000;

/** Shared by production bridges; tests inject a fresh instance. */
export class ExpiringControllerVersionMemory implements ControllerVersionMemory {
  private readonly legacySince = new Map<string, number>();

  isLegacy(controllerPath: string, nowMs: number): boolean {
    const markedAt = this.legacySince.get(controllerPath);
    if (markedAt === undefined) {
      return false;
    }
    if (nowMs - markedAt < NETWORK_FILTER_LEGACY_MEMORY_TTL_MS) {
      return true;
    }
    this.clear(controllerPath);
    return false;
  }

  markLegacy(controllerPath: string, nowMs: number): void {
    this.legacySince.set(controllerPath, nowMs);
  }

  clear(controllerPath: string): void {
    this.legacySince.delete(controllerPath);
  }
}
