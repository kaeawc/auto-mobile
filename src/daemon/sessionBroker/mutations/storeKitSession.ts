import type { DeviceMutationInput } from "./types";

/**
 * Journal vocabulary for `storeKitTest` (#18399): the iOS simulator runner keeps one in-memory
 * `SKTestSession` per bundle id for its lifetime, and keep-booted reuse keeps the runner, so a
 * later session would see the previous session's transactions, time rate, dialog setting or
 * simulated purchase error. Each touched bundle id records one `storekit` row whose prior is
 * `absent` (every keep-booted reset and every erase leaves no session behind); the iOS reset port
 * reverts it with the runner's `clear` action for that bundle id.
 */
export const STOREKIT_MUTATION_KIND = "storekit";

export function storeKitMutation(bundleId: string): Pick<DeviceMutationInput, "kind" | "key"> {
  return { kind: STOREKIT_MUTATION_KIND, key: bundleId };
}

export function isStoreKitMutation(entry: Pick<DeviceMutationInput, "kind">): boolean {
  return entry.kind === STOREKIT_MUTATION_KIND;
}

/** The runner's refusal when it holds no session record for the bundle id (see `StoreKitClearedSessions`). */
const NO_SESSION_ERROR = "no storekit session for bundleId";

export function isStoreKitSessionAbsentError(error: string | undefined): boolean {
  return error?.includes(NO_SESSION_ERROR) === true;
}

/** The narrow runner seam the iOS reset port needs to end a bundle's StoreKit test session. */
export interface IosStoreKitSessionReset {
  /** Resolves once the runner has no session for the bundle id; throws when that is unproven. */
  clear(deviceId: string, bundleId: string, signal: AbortSignal): Promise<void>;
}
