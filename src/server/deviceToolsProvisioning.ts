import { runWithAutolockPolicy } from "../daemon/deviceAutolockPolicy";
import { ProgressCallback } from "./toolRegistry";
import {
  getDeviceToolsDependencies,
  type ProvisionDeviceArgs,
} from "../features/deviceLifecycle/deviceLifecycleCore";
import type { CreatedDeviceRollback } from "./deviceToolsStartDevice";
import type { ProvisioningContext, ProvisioningHooks } from "./provisioning/provisioningTypes";
import { provisionDeviceHandler } from "./provisioning/provisioningRequest";
import { rollbackCreatedDevice } from "./provisioning/provisioningCreatedRollback";

export function createProvisionDeviceHandlers(hooks: ProvisioningHooks) {
  const ctx: ProvisioningContext = hooks;
  const rollback: CreatedDeviceRollback = (createdDevice, failure, options) =>
    rollbackCreatedDevice(ctx, createdDevice, failure, options);
  return {
    provisionDeviceHandler: (
      input: Partial<ProvisionDeviceArgs>,
      progress?: ProgressCallback,
      signal?: AbortSignal,
    ) =>
      runWithAutolockPolicy(getDeviceToolsDependencies().env, () =>
        provisionDeviceHandler(ctx, input, progress, signal),
      ),
    rollbackCreatedDevice: rollback,
  };
}
