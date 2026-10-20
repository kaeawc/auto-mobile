import {
  getPerformancePushServer,
  type PerformancePushSocketServer,
} from "../../daemon/performancePushSocketServer";
import {
  getDeviceDataStreamServer,
  type DeviceDataStreamSocketServer,
} from "../../daemon/deviceDataStreamSocketServer";
import {
  getTelemetryPushServer,
  type TelemetryPushSocketServer,
} from "../../daemon/telemetryPushSocketServer";
import type { PerformanceDemandProbe } from "./PerformanceMonitorTypes";

interface DemandProbeDependencies {
  getPerformancePushServer: () => Pick<
    PerformancePushSocketServer,
    "hasSubscriberForDevice"
  > | null;
  getDeviceDataStreamServer: () => Pick<
    DeviceDataStreamSocketServer,
    "hasSubscriberForDevice"
  > | null;
  getTelemetryPushServer: () => Pick<
    TelemetryPushSocketServer,
    "hasSubscriberForPerformanceTelemetry"
  > | null;
}

/** Read only current subscriber demand; registration alone is not a consumer. */
export function createDaemonPerformanceDemandProbe(
  deps: Partial<DemandProbeDependencies> = {},
): PerformanceDemandProbe {
  const getters = {
    getPerformancePushServer,
    getDeviceDataStreamServer,
    getTelemetryPushServer,
    ...deps,
  };
  return {
    hasDemand: (deviceId, packageName, platform) =>
      (getters.getPerformancePushServer()?.hasSubscriberForDevice(deviceId, packageName) ??
        false) ||
      (platform === "android" &&
        (getters.getDeviceDataStreamServer()?.hasSubscriberForDevice(deviceId) ?? false)) ||
      (getters.getTelemetryPushServer()?.hasSubscriberForPerformanceTelemetry(deviceId) ?? false),
  };
}
