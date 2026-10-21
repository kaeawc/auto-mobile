import {
  type AndroidBaselineResetDependencies,
  type AndroidResetProfile,
  type AndroidResetStrategy,
} from "../../../../src/daemon/sessionBroker/androidBaselineReset";
import type { BootedDevice, DeviceInfo } from "../../../../src/models/DeviceInfo";
import { createExecResult } from "../../../../src/utils/execResult";

export const ANDROID_RESET_PROFILE: AndroidResetProfile = {
  platform: "android",
  metadataState: "current",
  profileId: "pixel_phone",
  archetype: "phone",
  systemImagePackage: "system-images;android-35;google_apis;arm64-v8a",
  osVersion: "15",
  versionPrecision: "major",
  apiLevel: 35,
  abi: "arm64-v8a",
  flavor: "google_apis",
};

export const ANDROID_RESET_DEVICE: BootedDevice = {
  platform: "android",
  deviceId: "emulator-5554",
  name: "broker-avd",
};

export class FakeAndroidResetHost implements AndroidBaselineResetDependencies {
  devices: DeviceInfo[] = [
    {
      ...ANDROID_RESET_DEVICE,
      isRunning: true,
      apiLevel: 35,
      runtimeId: ANDROID_RESET_PROFILE.systemImagePackage,
      deviceType: ANDROID_RESET_PROFILE.profileId,
    },
  ];
  installed = new Set(["com.automobile.ctrlproxy"]);
  commands: string[] = [];
  safe = true;
  booted = true;
  healthy = true;
  packageManager = true;
  failCommand: string | undefined;
  strategy: AndroidResetStrategy | undefined;
  closed = 0;
  inventoryCalls = 0;
  lastInventorySignal: AbortSignal | undefined;
  onInventory: (() => void) | undefined;
  onHealth: (() => void) | undefined;

  async inventory(options?: { signal?: AbortSignal }): Promise<DeviceInfo[]> {
    this.inventoryCalls++;
    this.lastInventorySignal = options?.signal;
    this.onInventory?.();
    return this.devices;
  }

  adb() {
    return {
      executeCommand: async (command: string) => {
        this.commands.push(command);
        if (command === this.failCommand) {
          throw new Error("adb command timed out after 2000ms");
        }
        if (command === "shell getprop sys.boot_completed") {
          return createExecResult(this.booted ? "1" : "0", "");
        }
        if (command === "shell pm path android") {
          return createExecResult(
            this.packageManager ? "package:/system/framework/framework-res.apk" : "",
            "",
          );
        }
        if (command === "shell pm list packages -3") {
          return createExecResult(
            [...this.installed].map((name) => `package:${name}`).join("\n"),
            "",
          );
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    };
  }

  watchSession(_sessionId: string) {
    return {
      canReset: () => this.safe,
      close: () => {
        this.closed++;
      },
    };
  }

  async ctrlProxyReady(): Promise<boolean> {
    this.onHealth?.();
    return this.healthy;
  }
}
