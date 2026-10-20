/** Shared device lifecycle API. Implementations live in the cohesive core modules below. */
export type { ProgressCallback } from "../action/BaseVisualChange";
export {
  provisionDeviceDependencyOverrides,
  resolveDeviceToolsLifecycleCoordinator,
  resourceNotificationDependencyOverrides,
} from "./deviceLifecycleDependencyOverrides";
export { PooledAvdIdentityError } from "./PooledAvdIdentityError";
export * from "./core/provisioning";
export * from "./core/schemas";
export * from "./core/deadlines";
export * from "./core/contracts";
export * from "./core/inventory";
export * from "./core/dependencies";
export * from "./core/shutdownPreparation";
export * from "./core/teardownContracts";
export * from "./core/androidIdentity";
export * from "./core/teardownDiscovery";
export * from "./core/shutdownOwnership";
export * from "./core/shutdownDiscovery";
export * from "./core/teardownResolution";
export * from "./core/teardownVerification";
export * from "./core/bootSettlement";
export * from "./core/bootIdentity";
export * from "./core/systemUiRecovery";
export * from "./core/readiness";
export * from "./core/acquisition";
