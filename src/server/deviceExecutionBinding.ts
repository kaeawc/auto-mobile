import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import type { AmbientExecutionIdReader } from "../utils/interfaces/AmbientExecutionIdReader";

export const ambientExecutionIdReader: AmbientExecutionIdReader = {
  getExecutionId: () => getToolSelectionContext()?.execution?.executionId,
};

/** Admission binds the ambient execution without coupling device clients to the tracker. */
export interface DeviceExecutionBinding {
  bindDeviceExecution(deviceId: string): void;
}

// Stateless adapter; the ingress supplies the executionTracker-backed binding.
export const ambientDeviceExecutionBinding: DeviceExecutionBinding = {
  bindDeviceExecution(deviceId: string): void {
    getToolSelectionContext()?.execution?.deviceBinding?.bindDeviceExecution(deviceId);
  },
};
