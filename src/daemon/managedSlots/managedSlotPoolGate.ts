import type { DevicePool } from "../devicePool";

/**
 * The managed-slot checks a server-side entry point needs from the pool (#11174). Optional so a
 * daemon whose pool predates them (older test doubles) skips the check instead of crashing.
 */
export type ManagedSlotPoolGate = Partial<
  Pick<
    DevicePool,
    "assertNotAssignedToManagedSlot" | "managedSlotRefusalFor" | "managedSlotStableIds"
  >
>;

/** View a pool (or no pool) through {@link ManagedSlotPoolGate}. */
export function managedSlotPoolGate(pool: ManagedSlotPoolGate | undefined): ManagedSlotPoolGate {
  return pool ?? {};
}
