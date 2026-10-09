import type {
  DeviceResourceReconcileRequest,
  DeviceResourceReconciler,
} from "../../src/utils/deviceResourceReconciler";
import type { DeviceResourceReconciliation } from "../../src/models/DeviceResourceReconciliation";

export class FakeDeviceResourceReconciler implements DeviceResourceReconciler {
  readonly requests: DeviceResourceReconcileRequest[] = [];
  onRequest?: (request: DeviceResourceReconcileRequest) => Promise<void>;
  result: DeviceResourceReconciliation = {
    success: true,
    identity: {
      platform: "ios",
      udid: "12345678-1234-1234-1234-123456789ABC",
      runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
      deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
    },
    requested: { wallpaperRendering: "disabled" },
    profileFingerprint: "fingerprint",
    drift: [],
    remainingDrift: [],
    observed: {
      deviceId: "12345678-1234-1234-1234-123456789ABC",
      platform: "ios",
      resources: {
        wallpaperRendering: { state: "disabled" },
        widgets: { state: "enabled" },
        liveActivities: { state: "enabled" },
        backgroundSync: { state: "unsupported" },
        searchIndexing: { state: "enabled" },
        animations: { state: "unsupported" },
        icloudSync: { state: "unsupported" },
        photoAnalysis: { state: "enabled" },
      },
    },
    verification: "current_boot",
  };

  async reconcile(request: DeviceResourceReconcileRequest): Promise<DeviceResourceReconciliation> {
    this.requests.push(request);
    await this.onRequest?.(request);
    return this.result;
  }
}
