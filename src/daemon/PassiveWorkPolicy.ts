import { isAppearanceSyncEnabled } from "../utils/appearance/appearanceSyncPolicy";
import { ENV, readEnvRaw } from "../config/env";
import type { Platform } from "../models/Platform";

export { isAppearanceSyncEnabled } from "../utils/appearance/appearanceSyncPolicy";

export type PassiveWorkPlatform = Platform;
export type PassiveWorkKind = "appearance-sync" | "startup-warmup" | "observation-stream";

export interface PassiveWorkSettings {
  androidAppearanceSyncDevices: ReadonlySet<string>;
  androidObservationStreamDevices: ReadonlySet<string>;
  iosWarmupDevices: ReadonlySet<string>;
  appearanceSyncEnabled: boolean;
  iosPassiveWorkEnabled: boolean;
}

function parseDeviceIds(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function parsePassiveWorkSettings(
  env: NodeJS.ProcessEnv,
  iosAcceptanceSecretEnv: string,
): PassiveWorkSettings {
  return {
    androidAppearanceSyncDevices: parseDeviceIds(
      readEnvRaw(ENV.ANDROID_APPEARANCE_SYNC_DEVICES, env),
    ),
    androidObservationStreamDevices: parseDeviceIds(
      readEnvRaw(ENV.ANDROID_OBSERVATION_STREAM_DEVICES, env),
    ),
    iosWarmupDevices: parseDeviceIds(readEnvRaw(ENV.IOS_WARMUP_DEVICES, env)),
    appearanceSyncEnabled: isAppearanceSyncEnabled(readEnvRaw(ENV.APPEARANCE_SYNC, env)),
    iosPassiveWorkEnabled: env[iosAcceptanceSecretEnv] === undefined,
  };
}

export class PassiveWorkPolicy {
  constructor(
    private readonly settings: PassiveWorkSettings,
    private readonly isOwned: (deviceId: string) => boolean,
  ) {}

  allows(platform: PassiveWorkPlatform, kind: PassiveWorkKind, deviceId: string): boolean {
    if (platform === "watchos") {
      // No passive work (warmup, appearance sync, observation stream) runs on a watch.
      return false;
    }
    if (platform === "android") {
      if (kind === "appearance-sync" && !this.settings.appearanceSyncEnabled) {
        return false;
      }
      if (kind === "startup-warmup") {
        return false;
      }
      const allowlist =
        kind === "appearance-sync"
          ? this.settings.androidAppearanceSyncDevices
          : this.settings.androidObservationStreamDevices;
      return this.isOwned(deviceId) || allowlist.has(deviceId);
    }

    if (kind === "appearance-sync" || !this.settings.iosPassiveWorkEnabled) {
      return false;
    }
    return this.isOwned(deviceId) || this.settings.iosWarmupDevices.has(deviceId);
  }

  isAppearanceSyncEnabled(): boolean {
    return this.settings.appearanceSyncEnabled;
  }

  isIosPassiveWorkEnabled(): boolean {
    return this.settings.iosPassiveWorkEnabled;
  }
}
