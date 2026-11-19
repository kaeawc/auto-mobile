/**
 * Which bundles' StoreKit test state this daemon has seen cleared and not touched since (#18574).
 *
 * The runner keeps its `SKTestSession` records in memory, but StoreKit Testing keeps transactions
 * and settings in the simulator: the runner's `load` resets and clears them because a new session
 * inherits them. So a runner answering "no storekit session" proves only that its record is gone.
 * That happens after a confirmed `clear` (clean) and after a runner restart (state may remain).
 * This ledger tells the two apart: a confirmed `clear` marks the bundle clean, and any later
 * state-changing action unmarks it before it is sent. It is in memory, so after a daemon restart
 * nothing is marked and the keep-booted reset falls back to erasing the simulator.
 */
export interface StoreKitClearedSessions {
  /** A `clear` (tool or reset) confirmed the bundle's StoreKit state reset and its session ended. */
  markCleared(deviceId: string, bundleId: string): void;
  /** A state-changing action is about to be sent for the bundle. */
  markTouched(deviceId: string, bundleId: string): void;
  /** Whether a confirmed clear happened with no state-changing action since. */
  isCleared(deviceId: string, bundleId: string): boolean;
}

export class InMemoryStoreKitClearedSessions implements StoreKitClearedSessions {
  private readonly cleared = new Set<string>();

  markCleared(deviceId: string, bundleId: string): void {
    this.cleared.add(key(deviceId, bundleId));
  }

  markTouched(deviceId: string, bundleId: string): void {
    this.cleared.delete(key(deviceId, bundleId));
  }

  isCleared(deviceId: string, bundleId: string): boolean {
    return this.cleared.has(key(deviceId, bundleId));
  }
}

function key(deviceId: string, bundleId: string): string {
  return `${deviceId}\u0000${bundleId}`;
}

/** The daemon-wide ledger the storeKitTest tool and the iOS keep-booted reset share. */
export const defaultStoreKitClearedSessions: StoreKitClearedSessions =
  new InMemoryStoreKitClearedSessions();
