import { fixedBackoff } from "../../../utils/Backoff";
import { PlatformDeviceManager, type BootedDeviceDiscovery } from "../../../devices/deviceUtils";
import { BootedDevice } from "../../../models";
import { type Timer } from "../../../utils/SystemTimer";
import { getAbortSignal } from "../../../utils/AbortContext";
import { reconcileDiscoveryObservation } from "../../../daemon/discoveryReconcile";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import { isAndroidEmulatorSerial } from "../../../utils/androidSerial";
import {
  runWithinShutdownDeadline,
  shutdownTimeoutError,
  DEVICE_SHUTDOWN_TIMEOUT_MS,
} from "../core/deadlines";
import { getShutdownInitiatingExecutionId, isShutdownTimeoutError } from "./shutdownPreparation";
import { isUnknownAndroidRuntimeName } from "../identity/androidIdentity";
import { type ShutdownOwnershipContext } from "./shutdownOwnership";

export const DEVICE_SHUTDOWN_DISCOVERY_RECHECK_BACKOFF = fixedBackoff(1_000);

export interface ShutdownDiscoveryContext {
  deviceManager: PlatformDeviceManager;
  device: BootedDevice;
  timer: Timer;
  deadlineMs: number;
  requestAbortSignal: AbortSignal | undefined;
  timeoutMs: number;
}

/**
 * `skipAndroidNameEnrichment` is the shutdown-confirmation half of the same
 * `force` fast path `readTeardownTargetDiscovery` already gives target
 * RESOLUTION (#6864): a forced kill still confirms its target's disappearance
 * by discovery, and unforced discovery enriches every attached emulator with
 * `emu avd name`, sequentially, budgeting 2s each. Wedged peer consoles can
 * burn a whole forced teardown deadline confirming a kill that itself
 * completed instantly, reporting a shutdown timeout even though the platform
 * kill succeeded
 * ([#6874](https://github.com/kaeawc/auto-mobile/pull/6874) review). A
 * serial-only scan is enough here: `findDiscoveredDevice` matches by
 * `deviceId`, so the target's disappearance is confirmed without a name, and
 * an unresolved `Unknown (<serial>)` name on a still-present serial already
 * reads as "not yet a confirmed replacement" via
 * {@link isConfirmedDeviceReplacement}'s unresolved-name guard, the same
 * conservative "keep waiting" outcome an unforced caller gets from a
 * momentarily wedged console.
 */
export async function getShutdownDiscovery(
  context: ShutdownDiscoveryContext,
  skipAndroidNameEnrichment = false,
) {
  const { deviceManager, device, timer, deadlineMs, requestAbortSignal, timeoutMs } = context;
  return await runWithinShutdownDeadline(device, timer, deadlineMs, {
    detail: "platform discovery did not complete",
    requestAbortSignal: requestAbortSignal ?? getAbortSignal(),
    operation: async () => {
      const discovery = await deviceManager.getBootedDevicesDetailed(device.platform, {
        bypassAndroidDeviceListCache: true,
        ...(device.platform === "ios" ? { bypassIosDeviceListCache: true } : {}),
        ...(skipAndroidNameEnrichment ? { skipAndroidNameEnrichment: true } : {}),
      });
      // FUNNEL 1: the kill/teardown preflight decides whether the pooled AVD
      // label may be acted on destructively, so the pool must see this
      // observation before that decision (#6863 review).
      await reconcileDiscoveryObservation(discovery.devices, "shutdown-preflight", {
        // This kill IS the discovering execution. Entering the quarantine
        // cancels the pooled session's in-flight work, and without this
        // exemption that includes the kill awaiting this very observation: it
        // would lose the `runWithinShutdownDeadline` signal race and report a
        // device-loss failure instead of reaching confirm-or-refuse
        // ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
        excludeExecutionId: getShutdownInitiatingExecutionId(),
        signal: getAbortSignal(),
        namesResolved: !skipAndroidNameEnrichment,
      });
      return discovery;
    },
    timeoutMs: timeoutMs,
  });
}

export const DEVICE_SHUTDOWN_POLL_INTERVAL_MS = 1_000;

/**
 * The online-only discovery cannot see an emulator whose adb transport is
 * `offline`: the serial vanishes from it while the process keeps running
 * (#10074). Before an Android serial's absence counts as disappearance, ask adb
 * whether the serial is still attached in that state. Returns why disappearance
 * is NOT yet confirmed, or undefined when the serial is gone from `adb devices`.
 * A manager without the probe keeps the previous online-only behaviour.
 */
export async function androidOfflineHoldDetail(
  context: ShutdownDiscoveryContext,
): Promise<string | undefined> {
  const { deviceManager, device, timer, deadlineMs, requestAbortSignal, timeoutMs } = context;
  const probe = deviceManager.getAndroidOfflineDeviceIds?.bind(deviceManager);
  if (device.platform !== "android" || !probe) {
    return undefined;
  }
  try {
    const offline = await runWithinShutdownDeadline(device, timer, deadlineMs, {
      detail: "adb device-state read did not complete",
      requestAbortSignal: requestAbortSignal ?? getAbortSignal(),
      operation: async (signal, remainingMs) =>
        await probe([device.deviceId], { signal, timeoutMs: remainingMs }),
      timeoutMs,
    });
    return offline.has(device.deviceId) ? "adb still lists the device as offline" : undefined;
  } catch (error) {
    if (isShutdownTimeoutError(error) || requestAbortSignal?.aborted) {
      throw error;
    }
    // An unreadable state list cannot prove the serial left `adb devices`; keep
    // polling until the deadline rather than retire ownership of a live emulator.
    logger.warn(
      `[DeviceTools] adb device-state probe failed while confirming ${device.deviceId} stopped: ${errorMessage(error)}`,
      error,
    );
    return "adb device states could not be read to confirm the serial is gone";
  }
}

export type ShutdownDiscoveryJudgement =
  | { settled: true; replacement: BootedDevice | undefined }
  | { settled: false; detail: string };

/**
 * Whether this observation's name is the `Unknown (<serial>)` placeholder rather
 * than a name read from the runtime. Guarded by {@link isAndroidEmulatorSerial}:
 * a handset's name is `ro.product.model`, which is not unique and carries no
 * identity anyway, so handsets keep serial-only identity.
 */
export function hasUnresolvedEmulatorRuntimeName(device: BootedDevice): boolean {
  return (
    device.platform === "android" &&
    isAndroidEmulatorSerial(device.deviceId) &&
    isUnknownAndroidRuntimeName(device)
  );
}

/**
 * Whether a device rediscovered on a serial is positive evidence that a
 * DIFFERENT runtime now holds it -- the REPLACEMENT question, asked by the
 * shutdown wait before it stops waiting and rebuilds the pool around the
 * newcomer.
 *
 * Only a RESOLVED, different name declares a replacement. While an emulator
 * shuts down, `adb devices` can keep listing its serial after the console has
 * stopped answering `avd name`, so the device that is still present gets
 * labelled `Unknown (<serial>)`; classifying that as a replacement would end the
 * shutdown wait before disappearance and retirement, releasing the session and
 * rebuilding the pool around a device that is still going away (#6863 review).
 *
 * This is NOT the negation of {@link isSameBootedDeviceIdentity}: an unresolved
 * name answers neither question, so both predicates return false for it.
 */
export function isConfirmedDeviceReplacement(
  device: BootedDevice,
  candidate: BootedDevice,
): boolean {
  if (device.platform !== candidate.platform || device.deviceId !== candidate.deviceId) {
    return false;
  }
  if (hasUnresolvedEmulatorRuntimeName(device) || hasUnresolvedEmulatorRuntimeName(candidate)) {
    return false;
  }
  return device.name !== candidate.name;
}

export function findDiscoveredDevice(
  discovery: BootedDeviceDiscovery,
  device: BootedDevice,
): BootedDevice | undefined {
  if (!discovery.succeededPlatforms.has(device.platform)) {
    return undefined;
  }
  return discovery.devices.find(
    (candidate) => candidate.platform === device.platform && candidate.deviceId === device.deviceId,
  );
}

export async function judgeShutdownDiscovery(
  context: ShutdownDiscoveryContext,
  discovery: BootedDeviceDiscovery,
): Promise<ShutdownDiscoveryJudgement> {
  const { device } = context;
  const platformWasDiscovered = discovery.succeededPlatforms.has(device.platform);
  const matchingDevice = findDiscoveredDevice(discovery, device);
  if (platformWasDiscovered && !matchingDevice) {
    const offlineHoldDetail = await androidOfflineHoldDetail(context);
    return offlineHoldDetail === undefined
      ? { settled: true, replacement: undefined }
      : { settled: false, detail: offlineHoldDetail };
  }
  if (matchingDevice && isConfirmedDeviceReplacement(device, matchingDevice)) {
    return { settled: true, replacement: matchingDevice };
  }
  return {
    settled: false,
    detail: platformWasDiscovered
      ? "the device is still reported as booted"
      : "platform discovery did not succeed",
  };
}

export async function waitForDeviceShutdown(
  context: ShutdownDiscoveryContext,
  skipAndroidNameEnrichment = false,
): Promise<BootedDevice | undefined> {
  const { device, timer, deadlineMs, timeoutMs } = context;
  let lastDiscoveryDetail = "platform discovery did not complete";
  for (;;) {
    if (timer.now() >= deadlineMs) {
      throw shutdownTimeoutError(device, lastDiscoveryDetail, timeoutMs);
    }
    const discovery = await getShutdownDiscovery(context, skipAndroidNameEnrichment);
    const judgement = await judgeShutdownDiscovery(context, discovery);
    if (judgement.settled) {
      return judgement.replacement;
    }
    lastDiscoveryDetail = judgement.detail;
    const remainingMs = deadlineMs - timer.now();
    if (remainingMs <= 0) {
      throw shutdownTimeoutError(device, lastDiscoveryDetail, timeoutMs);
    }
    await timer.sleep(Math.min(DEVICE_SHUTDOWN_POLL_INTERVAL_MS, remainingMs));
  }
}

export const DEVICE_SHUTDOWN_POST_RELEASE_RECHECK_TIMEOUT_MS = 1_000;

export function shutdownRecheckDeadlineMs(
  timer: Timer,
  deadlineMs: number,
  strictDeadline: boolean,
): number {
  if (strictDeadline) {
    return deadlineMs;
  }
  return Math.max(deadlineMs, timer.now() + DEVICE_SHUTDOWN_POST_RELEASE_RECHECK_TIMEOUT_MS);
}

export async function findReplacementAfterSessionRelease(
  context: ShutdownOwnershipContext,
  strictDeadline = false,
  timeoutMs = DEVICE_SHUTDOWN_TIMEOUT_MS,
  skipAndroidNameEnrichment = false,
): Promise<BootedDevice | undefined> {
  const { deviceManager, device, timer, deadlineMs, requestAbortSignal } = context;
  // The absence observation only proves the old incarnation was gone before
  // session release. A same-ID replacement can appear while that release
  // awaits persistence, so ordinary shutdown keeps a short, bounded recheck
  // even after the disappearance deadline was consumed.
  // Under force, a replacement can only be confirmed by a DIFFERING resolved
  // name (see `isConfirmedDeviceReplacement`), so this serial-only recheck
  // reports no confirmed replacement quickly instead of probing every peer's
  // console -- the same conservative trade-off as the pre-release scan (#6864).
  const recheckDeadlineMs = shutdownRecheckDeadlineMs(timer, deadlineMs, strictDeadline);
  const discovery = await getShutdownDiscovery(
    { deviceManager, device, timer, deadlineMs: recheckDeadlineMs, requestAbortSignal, timeoutMs },
    skipAndroidNameEnrichment,
  );
  const replacement = findDiscoveredDevice(discovery, device);
  if (
    replacement &&
    (device.platform === "ios" || isConfirmedDeviceReplacement(device, replacement))
  ) {
    return replacement;
  }
  if (!replacement && discovery.succeededPlatforms.has(device.platform)) {
    return undefined;
  }
  return await waitForDeviceShutdown(
    { deviceManager, device, timer, deadlineMs: recheckDeadlineMs, requestAbortSignal, timeoutMs },
    skipAndroidNameEnrichment,
  );
}
