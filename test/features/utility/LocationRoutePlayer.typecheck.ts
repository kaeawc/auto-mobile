import type { registerLocationRouteSessionCleanup } from "../../../src/features/utility/LocationRoutePlayer";

type Assert<Condition extends true> = Condition;
type CleanupManager = Parameters<typeof registerLocationRouteSessionCleanup>[0];

/** Compile-only regression check: lifecycle hooks must publish device quarantine. */
export type LocationRouteCleanupContractCheck = Assert<
  Omit<CleanupManager, "registerPendingDeviceCleanup"> extends CleanupManager ? false : true
>;
