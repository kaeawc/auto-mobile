import { ActionableError } from "../models";
import { DaemonState } from "../daemon/daemonState";
import { reconcileDiscoveryObservation } from "../daemon/discoveryReconcile";
import type { DevicePool } from "../daemon/devicePool";
import type { PlatformDeviceManager } from "../utils/deviceUtils";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import {
  getStartDevicePool,
  isUnknownAndroidRuntimeName,
  runWithinShutdownDeadline,
} from "./deviceTools";
import type { StartDeviceArgs } from "./deviceTools";

/**
 * A `deviceId`-targeted acquisition owns exactly one AVD, so it must not take the
 * wildcard startup lease: `androidStartupRequestMatchesAvd` short-circuits on a
 * missing name, which makes `detachAdbServerResetCohort` defer *every* cohort and
 * the DisconnectMonitor skip its entire iteration for the minutes the lease is
 * held. The pool already knows a running serial's AVD name, and an AVD image name
 * (the other spelling `deviceId` accepts) resolves against the image listing.
 * Returning `undefined` falls back to the wildcard, which is correct only when the
 * identifier names neither a pooled serial nor a known image, or the request is
 * criteria-only, where any AVD really may still be picked.
 */
interface AndroidStartupLeaseNameContext {
  args: StartDeviceArgs;
  budgets: { androidAvdName?: string };
  devicePool: DevicePool;
  deviceUtils: PlatformDeviceManager;
  bootDeadlineMs: number;
  timer: Timer;
  signal: AbortSignal | undefined;
}

async function resolveAndroidStartupLeaseAvdName({
  args,
  budgets,
  devicePool,
  deviceUtils,
  bootDeadlineMs,
  timer,
  signal,
}: AndroidStartupLeaseNameContext): Promise<string | undefined> {
  if (budgets.androidAvdName !== undefined) {
    return budgets.androidAvdName;
  }
  if (args.matchExactName && args.name) {
    return args.name;
  }
  if (!args.deviceId) {
    return undefined;
  }
  const pooled = devicePool.getDevice(args.deviceId);
  if (pooled) {
    return pooled.avdName;
  }
  // Not a running serial: on Android `deviceId` doubles as an AVD image name
  // (see `getAndroidSchema`), and the pool is keyed by serial, so an image that
  // is not running yet is unknown to it. Name the lease after the image rather
  // than taking the wildcard, which would make this exact acquisition wait on —
  // and defer — every unrelated reset cohort.
  return await resolveAndroidStartupLeaseImageName(
    args.deviceId,
    deviceUtils,
    bootDeadlineMs,
    timer,
    signal,
  );
}

/**
 * The requested identifier when it names a known, bounded-listing AVD image;
 * `undefined` when it names none, which keeps the wildcard lease for genuinely
 * unresolvable requests. A failed listing also falls back to the wildcard: the
 * lease is a coordination hint, and failing the acquisition over an optional
 * lookup would be worse than a briefly over-broad lease.
 */
async function resolveAndroidStartupLeaseImageName(
  deviceId: string,
  deviceUtils: PlatformDeviceManager,
  bootDeadlineMs: number,
  timer: Timer,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    // This optional hint must leave time to reserve the non-owning lease and
    // continue acquisition when image discovery does not answer.
    const lookupDeadlineMs = Math.min(bootDeadlineMs, timer.now() + 5_000);
    const images = await runWithinShutdownDeadline(
      { name: deviceId, platform: "android", deviceId },
      timer,
      lookupDeadlineMs,
      "Android AVD image lookup for the startup lease did not complete",
      signal,
      async (lookupSignal) => await deviceUtils.listDeviceImages("android", lookupSignal),
      undefined,
      "to name its Android startup lease",
    );
    return images.some((image) => image.platform === "android" && image.name === deviceId)
      ? deviceId
      : undefined;
  } catch (error) {
    logger.warn(
      `[DeviceTools] Could not resolve AVD image '${deviceId}' for the startup lease: ${errorMessage(error)}`,
      error,
    );
    return undefined;
  }
}

export async function reserveAndroidStartupLease(
  args: StartDeviceArgs,
  budgets: { androidAvdName?: string },
  bootDeadlineMs: number,
  timer: Timer,
  deviceUtils: PlatformDeviceManager,
  signal?: AbortSignal,
): Promise<(() => Promise<void>) | undefined> {
  if (args.platform !== "android") {
    return undefined;
  }
  const devicePool = getStartDevicePool(DaemonState.getInstance());
  if (!devicePool) {
    return undefined;
  }
  const exactAvdName = await resolveAndroidStartupLeaseAvdName({
    args,
    budgets,
    devicePool,
    deviceUtils,
    bootDeadlineMs,
    timer,
    signal,
  });
  // Read after the resolution above so the wait reflects the budget it left.
  const remainingMs = bootDeadlineMs - timer.now();
  const requestedName = exactAvdName ?? args.name;
  if (remainingMs <= 0) {
    throw new ActionableError(
      `Timed out waiting for Android AVD reset recovery${requestedName ? ` of '${requestedName}'` : ""}`,
    );
  }
  const timeoutController = new AbortController();
  const abortForTimeout = () =>
    timeoutController.abort(
      new ActionableError(
        `Timed out waiting for Android AVD reset recovery${requestedName ? ` of '${requestedName}'` : ""}`,
      ),
    );
  const abortForCaller = () =>
    timeoutController.abort(signal?.reason ?? new Error("Device preparation cancelled"));
  if (signal?.aborted) {
    abortForCaller();
  } else {
    signal?.addEventListener("abort", abortForCaller, { once: true });
  }
  const timeout = timer.setTimeout(abortForTimeout, remainingMs);
  try {
    const ownsOfflineRecovery = await ownsAndroidStartupOfflineRecovery(
      exactAvdName,
      devicePool,
      deviceUtils,
      bootDeadlineMs,
      timer,
      timeoutController.signal,
    );
    return await devicePool.reserveAndroidStartupLease(
      requestedName,
      exactAvdName !== undefined,
      timeoutController.signal,
      ownsOfflineRecovery,
    );
  } finally {
    timer.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortForCaller);
  }
}

async function ownsAndroidStartupOfflineRecovery(
  avdName: string | undefined,
  devicePool: DevicePool,
  deviceUtils: PlatformDeviceManager,
  deadlineMs: number,
  timer: Timer,
  signal: AbortSignal,
): Promise<boolean> {
  // A criteria-only request may reuse a running AVD, so it cannot claim
  // ownership until an exact image has been resolved.
  if (!avdName) {
    return false;
  }
  // A pooled Android runtime may already be this AVD, including one whose
  // emulator name could not be resolved. Treat it as warm without rediscovery.
  if (
    devicePool
      .getAllDevices()
      .some(
        (device) =>
          device.platform === "android" &&
          (device.avdName === avdName ||
            device.name === avdName ||
            device.name === `Unknown (${device.id})`),
      )
  ) {
    return false;
  }
  try {
    const lookupDeadlineMs = Math.min(deadlineMs, timer.now() + 5_000);
    const booted = await runWithinShutdownDeadline(
      { platform: "android", name: avdName, deviceId: avdName },
      timer,
      lookupDeadlineMs,
      "Android startup lease running-device discovery did not complete",
      signal,
      async (signal) => {
        const discovery = await deviceUtils.getBootedDevicesDetailed("android", {
          bypassAndroidDeviceListCache: true,
          signal,
        });
        if (!discovery.succeededPlatforms.has("android")) {
          throw new Error("Android startup lease running-device discovery was unavailable");
        }
        await reconcileDiscoveryObservation(discovery.devices, "android-startup-offline-recovery", {
          signal,
        });
        return discovery.devices;
      },
    );
    // An unresolved emulator name may be this AVD. Fail open rather than
    // suppressing the disconnect monitor's only recovery for a warm device.
    return !booted.some((device) => device.name === avdName || isUnknownAndroidRuntimeName(device));
  } catch (error) {
    // An uncertain running state must not suppress the monitor's recovery.
    logger.warn(
      `[DeviceTools] Could not classify startup lease for '${avdName}': ${errorMessage(error)}`,
      error,
    );
    return false;
  }
}
