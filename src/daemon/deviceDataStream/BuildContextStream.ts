import type { Timer } from "../../utils/SystemTimer";
import type { DeviceBuildKey, InitialFrameSubscriber } from "./streamContracts";

interface BuildContextMessage {
  type: "device_build_context";
  deviceId: string;
  packageId: string;
  timestamp: number;
  buildKey: DeviceBuildKey | null;
}

export interface BuildContextStreamHost {
  readonly timer: Timer;
  resolveUuid(deviceId: string): string | null;
  pushForDevice(
    deviceId: string,
    message: BuildContextMessage,
    target?: InitialFrameSubscriber,
  ): number;
}

/** Publishes build provenance and replays cached package keys only within their device epoch. */
export class BuildContextStream {
  constructor(private readonly host: BuildContextStreamHost) {}

  private readonly buildKeysByDevice = new Map<
    string,
    { deviceSessionUuid: string; keys: Map<string, DeviceBuildKey> }
  >();

  removeDevice(deviceId: string): void {
    this.buildKeysByDevice.delete(deviceId);
  }

  /** Lightweight provenance updates reuse the device-stamping path; unknown keys are omitted. */
  pushBuildContextUpdate(
    deviceId: string,
    packageId: string,
    buildKey: DeviceBuildKey | null,
  ): void {
    if (buildKey?.contentHash === "") {
      if (!this.buildKeysByDevice.get(deviceId)?.keys.has(packageId)) {
        return;
      }
      buildKey = null;
    }
    this.host.pushForDevice(deviceId, {
      type: "device_build_context",
      deviceId,
      packageId,
      timestamp: this.host.timer.now(),
      buildKey: buildKey === null ? null : { ...buildKey, packageId },
    });
  }

  cacheBuildContext(
    deviceId: string,
    deviceSessionUuid: string | null,
    message: { packageId?: string; buildKey?: DeviceBuildKey | null },
  ): void {
    const previous = this.buildKeysByDevice.get(deviceId);
    if (previous?.deviceSessionUuid !== deviceSessionUuid) {
      this.buildKeysByDevice.delete(deviceId);
    }
    // Unbound serials still reach all-device subscribers but never seed replay for a future epoch.
    if (deviceSessionUuid === null || !message.packageId) {
      return;
    }
    const entry = this.buildKeysByDevice.get(deviceId) ?? {
      deviceSessionUuid,
      keys: new Map<string, DeviceBuildKey>(),
    };
    if (message.buildKey) {
      entry.keys.set(message.packageId, { ...message.buildKey });
    } else {
      entry.keys.delete(message.packageId);
    }
    if (entry.keys.size > 0) {
      this.buildKeysByDevice.set(deviceId, entry);
    } else {
      this.buildKeysByDevice.delete(deviceId);
    }
  }

  replayBuildContexts(target: InitialFrameSubscriber): void {
    for (const [deviceId, entry] of this.buildKeysByDevice) {
      if (this.host.resolveUuid(deviceId) !== entry.deviceSessionUuid) {
        continue;
      }
      for (const [packageId, buildKey] of entry.keys) {
        this.host.pushForDevice(
          deviceId,
          {
            type: "device_build_context",
            deviceId,
            packageId,
            timestamp: this.host.timer.now(),
            buildKey,
          },
          target,
        );
      }
    }
  }
}
