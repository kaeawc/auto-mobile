import type { DevicePool } from "../../devicePool";

/**
 * The broker binding checks a server-side entry point needs from the pool (#11174). Optional so a
 * daemon whose pool predates them (older test doubles) skips the check instead of crashing.
 */
export type BindingPoolGate = Partial<
  Pick<
    DevicePool,
    | "assertNotAssignedToBinding"
    | "bindingRefusalFor"
    | "bindingStableIds"
    | "bindingSnapshotRetainedAfterFailedRead"
  >
>;

/** View a pool (or no pool) through {@link BindingPoolGate}. */
export function bindingPoolGate(pool: BindingPoolGate | undefined): BindingPoolGate {
  return pool ?? {};
}
