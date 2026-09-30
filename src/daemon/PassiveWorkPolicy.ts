export type PassiveWorkPlatform = "android" | "ios";
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

export function isAppearanceSyncEnabled(value: string | undefined): boolean {
  return !["0", "false", "off", "no"].includes(value?.trim().toLowerCase() ?? "");
}

export function parsePassiveWorkSettings(
  env: NodeJS.ProcessEnv,
  iosAcceptanceSecretEnv: string,
): PassiveWorkSettings {
  return {
    androidAppearanceSyncDevices: parseDeviceIds(env.AUTOMOBILE_ANDROID_APPEARANCE_SYNC_DEVICES),
    androidObservationStreamDevices: parseDeviceIds(
      env.AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES,
    ),
    iosWarmupDevices: parseDeviceIds(env.AUTOMOBILE_IOS_WARMUP_DEVICES),
    appearanceSyncEnabled: isAppearanceSyncEnabled(env.AUTOMOBILE_APPEARANCE_SYNC),
    iosPassiveWorkEnabled: env[iosAcceptanceSecretEnv] === undefined,
  };
}

export class PassiveWorkPolicy {
  constructor(
    private readonly settings: PassiveWorkSettings,
    private readonly isOwned: (deviceId: string) => boolean,
  ) {}

  allows(platform: PassiveWorkPlatform, kind: PassiveWorkKind, deviceId: string): boolean {
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
