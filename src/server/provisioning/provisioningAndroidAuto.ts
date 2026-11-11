import type { BootedDevice } from "../../models";
import { ProvisionDeviceError } from "../../devices/exactDeviceProvisioning";
import {
  defaultAndroidAutoProjectionApplier,
  type AndroidAutoProjectionApplier,
  type AndroidAutoProvisionReport,
} from "../../features/androidAuto/AndroidAutoProjectionService";
import type {
  DeviceToolsDependencies,
  ProvisionDeviceArgs,
} from "../../features/deviceLifecycle/deviceLifecycleCore";
import { errorMessage } from "../../utils/describeUnknownError";

function androidAutoApplier(
  deps: Pick<DeviceToolsDependencies, "androidAutoProjection">,
): AndroidAutoProjectionApplier {
  return deps.androidAutoProjection ?? defaultAndroidAutoProjectionApplier();
}

/**
 * Refuse before any lease, creation or boot when the Android Auto APK directory, the Desktop
 * Head Unit or its config is missing on the host: the run could only fail after the boot.
 */
export async function assertAndroidAutoInputsPresent(
  args: ProvisionDeviceArgs,
  deps: Pick<DeviceToolsDependencies, "androidAutoProjection">,
): Promise<void> {
  if (!args.androidAuto) {
    return;
  }
  try {
    await androidAutoApplier(deps).resolveInputs(args.androidAuto);
  } catch (error) {
    throw new ProvisionDeviceError(
      "unsupported",
      `${errorMessage(error)} Nothing was created or booted.`,
      false,
    );
  }
}

/**
 * Set up Android Auto projection on the bound session's ready phone emulator. A failure fails
 * the provision like any other post-boot step, so its rollback applies.
 */
export async function applyProvisionAndroidAuto(
  args: ProvisionDeviceArgs,
  deps: Pick<DeviceToolsDependencies, "androidAutoProjection">,
  device: BootedDevice,
  signal?: AbortSignal,
): Promise<AndroidAutoProvisionReport | undefined> {
  if (!args.androidAuto || device.platform !== "android") {
    return undefined;
  }
  return androidAutoApplier(deps).apply(device, args.androidAuto, signal);
}
