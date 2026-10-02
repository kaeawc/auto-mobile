import type { registerLocationRouteSessionCleanup } from "../../../src/features/utility/LocationRoutePlayer";
import type { MockLocationClears } from "../../../src/features/utility/MockLocationClear";

type Assert<Condition extends true> = Condition;
type CleanupManager = Parameters<typeof registerLocationRouteSessionCleanup>[0];

/** Compile-only regression check: lifecycle hooks must publish device quarantine. */
export type LocationRouteCleanupContractCheck = Assert<
  Omit<CleanupManager, "registerPendingDeviceCleanup"> extends CleanupManager ? false : true
>;

/** Both cleanup registries are options, retaining the injectable clear interface. */
export type MockLocationCleanupOptionsCheck = Assert<
  { mockLocationClears: MockLocationClears } extends NonNullable<
    Parameters<typeof registerLocationRouteSessionCleanup>[1]
  >
    ? true
    : false
>;
