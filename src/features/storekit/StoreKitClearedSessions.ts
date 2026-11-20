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
  /** Whether this daemon sent a state-changing action for the bundle since its last confirmed clear. */
  isTouched(deviceId: string, bundleId: string): boolean;
}

export class InMemoryStoreKitClearedSessions implements StoreKitClearedSessions {
  private readonly cleared = new Set<string>();
  private readonly touched = new Set<string>();

  markCleared(deviceId: string, bundleId: string): void {
    this.cleared.add(key(deviceId, bundleId));
    this.touched.delete(key(deviceId, bundleId));
  }

  markTouched(deviceId: string, bundleId: string): void {
    this.cleared.delete(key(deviceId, bundleId));
    this.touched.add(key(deviceId, bundleId));
  }

  isCleared(deviceId: string, bundleId: string): boolean {
    return this.cleared.has(key(deviceId, bundleId));
  }

  isTouched(deviceId: string, bundleId: string): boolean {
    return this.touched.has(key(deviceId, bundleId));
  }
}

function key(deviceId: string, bundleId: string): string {
  return `${deviceId}\u0000${bundleId}`;
}

/**
 * The runner's refusal of a `load` while another bundle's environment is active. It is thrown
 * before the runner creates, resets or clears any session, so the call changed nothing.
 */
const OTHER_BUNDLE_ACTIVE_ERROR = "storekit environment active for bundleId";

export function isStoreKitOtherBundleActiveError(error: string | undefined): boolean {
  return error?.includes(OTHER_BUNDLE_ACTIVE_ERROR) === true;
}

/** The daemon-wide ledger the storeKitTest tool and the iOS keep-booted reset share. */
export const defaultStoreKitClearedSessions: StoreKitClearedSessions =
  new InMemoryStoreKitClearedSessions();
