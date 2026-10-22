import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { errorMessage } from "../../utils/describeUnknownError";
import type {
  DeviceClientProvider,
  DeviceReadyOptions,
  DeviceClientSimctl,
  ResolvedDeviceIdentity,
} from "./DeviceReadiness";
import { ActionableError, BootedDevice } from "../../models";
import { checkIosCtrlProxyOverride } from "../../utils/iosCtrlProxyOverride";
import { logger } from "../../utils/logger";

export function assertUsableIosOverride(
  iosOverride: Awaited<ReturnType<typeof checkIosCtrlProxyOverride>>,
): void {
  if (iosOverride.present && !iosOverride.usable) {
    throw new ActionableError(
      `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH / _IPA_PATH is set but unusable: ${iosOverride.reason}`,
    );
  }
}

export function androidReadinessWindowDevice(
  device: BootedDevice,
  resolvedIdentity?: ResolvedDeviceIdentity,
): BootedDevice {
  return resolvedIdentity?.deviceId === device.deviceId
    ? {
        ...device,
        name: resolvedIdentity.name,
        ...(resolvedIdentity.observedAt === undefined
          ? {}
          : { observedAt: resolvedIdentity.observedAt }),
      }
    : device;
}

export function assertAndroidActiveWindow(
  deviceId: string,
  activeWindow: Awaited<ReturnType<ReturnType<DeviceClientProvider["getWindow"]>["getActive"]>>,
): void {
  if (!activeWindow || !activeWindow.appId || !activeWindow.activityName) {
    logger.warn(`[DeviceReadiness] Android device ${deviceId} is not fully ready`);
    if (activeWindow) {
      logger.warn(
        `[DeviceReadiness] activeWindow.appId: ${activeWindow.appId} | activeWindow.activityName: ${activeWindow.activityName}`,
      );
    } else {
      logger.warn(`[DeviceReadiness] activeWindow: ${activeWindow}`);
    }
    throw new ActionableError(
      `Cannot get active window information from Android device ${deviceId}. The device may not be fully booted or is in an unusual state.`,
    );
  }
}

export function assertIosDeviceAvailable(
  deviceId: string,
  deviceInfo: Awaited<ReturnType<DeviceClientSimctl["getDeviceInfo"]>>,
): asserts deviceInfo is NonNullable<Awaited<ReturnType<DeviceClientSimctl["getDeviceInfo"]>>> {
  if (!deviceInfo) {
    throw new ActionableError(
      `iOS simulator ${deviceId} is not available. Please check if it exists and is available.`,
    );
  }

  if (!deviceInfo.isAvailable) {
    throw new ActionableError(
      `iOS simulator ${deviceId} is not available (state: ${deviceInfo.state}). Please check simulator availability.`,
    );
  }
}

async function isAndroidAsleep(
  adbFactory: AdbClientFactory,
  device: BootedDevice,
): Promise<boolean> {
  try {
    return !(await adbFactory.create(device).isScreenOn());
  } catch (error) {
    // Unknown wakefulness keeps the original window failure.
    logger.warn(`[DeviceReadiness] Could not read screen state of ${device.deviceId}`, error);
    return false;
  }
}

/** The device must show an active window; a sleeping device is exempt for booted-only callers. */
export async function verifyAndroidWindow(
  deps: { provider: DeviceClientProvider; adbFactory: AdbClientFactory },
  device: BootedDevice,
  resolvedIdentity: ResolvedDeviceIdentity | undefined,
  options: DeviceReadyOptions | undefined,
): Promise<void> {
  const { deviceId } = device;
  try {
    logger.info(`[DeviceReadiness] Verifying Android device ${deviceId} readiness`);
    const window = deps.provider.getWindow(androidReadinessWindowDevice(device, resolvedIdentity));
    assertAndroidActiveWindow(deviceId, await window.getActive(true));
  } catch (error) {
    // An asleep device has no focused window to read; power faking and waking must reach it.
    if (!(options?.readiness === "booted" && (await isAndroidAsleep(deps.adbFactory, device)))) {
      throw new ActionableError(
        `Failed to verify Android device ${deviceId} readiness: ${errorMessage(error)}`,
      );
    }
    logger.info(`[DeviceReadiness] Android device ${deviceId} is asleep; booted readiness holds`);
  }
}
