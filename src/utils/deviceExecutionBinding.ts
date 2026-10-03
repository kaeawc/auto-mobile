import { AsyncLocalStorage } from "node:async_hooks";

/** Admission binds the ambient execution without coupling device clients to the tracker. */
export interface DeviceExecutionBinding {
  bindDeviceExecution(deviceId: string): void;
}

const executionBinding = new AsyncLocalStorage<{ binding?: DeviceExecutionBinding }>();

/** Ingress publishes the binding of its resolved (possibly inherited) execution. */
export function runWithDeviceExecutionBinding<T>(
  binding: DeviceExecutionBinding | undefined,
  fn: () => T,
): T {
  return executionBinding.run({ binding }, fn);
}

export const ambientDeviceExecutionBinding: DeviceExecutionBinding = {
  bindDeviceExecution(deviceId): void {
    executionBinding.getStore()?.binding?.bindDeviceExecution(deviceId);
  },
};
