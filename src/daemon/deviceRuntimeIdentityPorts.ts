import type { PlatformDeviceManager } from "../devices/deviceUtils";
import { type RetryExecutor } from "../utils/retry/RetryExecutor";
import type { Timer } from "../utils/SystemTimer";
import { type DiscoveryReconcileOptions, type PooledDevice } from "./devicePool";
import { deviceLossCancellationReason } from "./emulatorLossIncident";

export type DeviceRetirementOptions = Pick<DiscoveryReconcileOptions, "excludeExecutionId"> & {
  /** ANR failure releases session work separately and retains sessionless work. */
  cancelDeviceBoundExecutions?: boolean;
};

/** Mutable pool state is read at use time, including after every await. */
export interface DeviceRuntimeIdentityPoolPort {
  getAmbientExecutionId?(): string | undefined;
  getDevices(): ReadonlyMap<string, PooledDevice>;
  notifyDeviceFramesInvalidated?(deviceId: string): void;
  getDeviceManager(): PlatformDeviceManager;
  getRetryExecutor(): RetryExecutor;
  getTimer(): Timer;
  getRefreshGeneration(): number;
  hasReusableSerial(device: PooledDevice): boolean;
  isReservedForShutdown(device: PooledDevice): boolean;
  cancelDeviceExecutions?(
    deviceId: string,
    reason: ReturnType<typeof deviceLossCancellationReason>,
    options: { excludeExecutionId?: string },
  ): Promise<number>;
  cancelDeviceSessionExecutions(
    sessionId: string,
    reason: ReturnType<typeof deviceLossCancellationReason>,
    options: { excludeExecutionId?: string },
  ): Promise<number>;
}
