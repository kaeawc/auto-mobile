import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { BootedDevice } from "../../models/DeviceInfo";
import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { normalizeIosVersion } from "../../utils/ios-cmdline-tools/SimCtlSupport";
import { compareIosVersions } from "../../utils/ios-cmdline-tools/iosVersion";
import type { BrokerNativeProfile } from "./profile";

export type IosResetProfile = Extract<BrokerNativeProfile, { platform: "ios" }>;

export function assertIosResetInput(device: BootedDevice, profile: IosResetProfile): void {
  if (device.platform !== "ios" || !device.deviceId.trim()) {
    throw new ActionableError("iOS baseline reset requires an exact iOS simulator UDID");
  }
  if (
    profile.platform !== "ios" ||
    !profile.simulatorDeviceTypeIdentifier.trim() ||
    !profile.runtimeId.trim() ||
    !profile.osVersion.trim()
  ) {
    throw new ActionableError("iOS baseline reset requires a complete exact iOS profile");
  }
}

export async function readExpectedIosResetTarget(
  simctl: Pick<SimCtl, "readSimulatorTarget">,
  udid: string,
  profile: IosResetProfile,
  {
    state: expectedState,
    action,
    timeoutMs,
    signal,
  }: {
    state: "Booted" | "Shutdown";
    action: string;
    /** Bounds the inventory read; omitted reads use the simctl default. */
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<void> {
  let target;
  try {
    target =
      timeoutMs !== undefined
        ? await simctl.readSimulatorTarget(udid, timeoutMs, signal)
        : await simctl.readSimulatorTarget(udid);
  } catch (error) {
    throw toActionableError(error, `Cannot ${action}: fresh iOS simulator inventory failed`);
  }
  if (!target || target.udid !== udid) {
    throw new ActionableError(
      `Cannot ${action}: fresh iOS simulator inventory did not prove one exact target '${udid}'`,
    );
  }
  const iosVersion = normalizeIosVersion(target.runtime, target.os_version);
  if (
    ![
      target.isAvailable === true,
      target.deviceTypeIdentifier === profile.simulatorDeviceTypeIdentifier,
      target.runtime === profile.runtimeId,
      compareIosVersions(iosVersion, profile.osVersion) === 0,
      target.state === expectedState,
    ].every(Boolean)
  ) {
    throw new ActionableError(
      `Cannot ${action}: simulator '${udid}' lacks authoritative ${expectedState} ` +
        "identity, runtime, type, OS, or availability evidence",
    );
  }
}
