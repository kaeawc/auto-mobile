import type { BootedDevice } from "../../models";
import { ProvisionDeviceError } from "../../devices/exactDeviceProvisioning";
import {
  defaultAndroidAutoProjectionApplier,
  existingDefaultAndroidAutoProjectionApplier,
  type AndroidAutoProjectionApplier,
  type AndroidAutoProvisionReport,
} from "../../features/androidAuto/AndroidAutoProjectionService";
import {
  runProvisionDeviceWithinDeadline,
  type DeviceToolsDependencies,
  type ProvisionDeviceArgs,
} from "../../features/deviceLifecycle/deviceLifecycleCore";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { ProvisionSettlementState } from "./provisioningTypes";

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
 * Set up Android Auto projection on the bound session's ready phone emulator, bounded by the
 * provision's total deadline and its abort signal. A failure fails the provision like any other
 * post-boot step, so its rollback applies. A request without `androidAuto` is untouched, abort
 * included.
 */
export async function applyProvisionAndroidAuto(
  args: ProvisionDeviceArgs,
  deps: Pick<DeviceToolsDependencies, "androidAutoProjection" | "timer">,
  device: BootedDevice,
  {
    signal,
    totalDeadlineMs,
    settlementState,
  }: {
    signal: AbortSignal;
    totalDeadlineMs: number;
    /** Records the device once the run starts, so a failed provision stops its DHU. */
    settlementState?: Pick<ProvisionSettlementState, "androidAutoDevice">;
  },
): Promise<AndroidAutoProvisionReport | undefined> {
  const options = args.androidAuto;
  if (!options || device.platform !== "android") {
    return undefined;
  }
  signal.throwIfAborted();
  if (settlementState) {
    settlementState.androidAutoDevice = device;
  }
  const applier = androidAutoApplier(deps);
  return await runProvisionDeviceWithinDeadline(deps.timer, totalDeadlineMs, signal, {
    phase: "setting up Android Auto projection",
    operation: (operationSignal) => applier.apply(device, options, operationSignal),
    // A run that outlives the deadline may still connect a DHU; stop it once the run settles.
    onPendingSettlement: (settlement) => {
      const stop = () => applier.stopDesktopHeadUnit(device.deviceId);
      void settlement.then(stop, stop);
    },
  });
}

/**
 * Stop the DHU this daemon spawned for `device` (bounded; never rejects) and forget it, so a
 * failed provision or a stopped emulator does not leave one holding host port 5277. A daemon
 * that never projected has nothing to stop and builds nothing.
 */
export async function stopProvisionedAndroidAuto(
  deps: Pick<DeviceToolsDependencies, "androidAutoProjection">,
  device: BootedDevice,
  { deviceStopped = false }: { deviceStopped?: boolean } = {},
): Promise<void> {
  if (device.platform !== "android") {
    return;
  }
  const applier = deps.androidAutoProjection ?? existingDefaultAndroidAutoProjectionApplier();
  try {
    await applier?.stopDesktopHeadUnit(device.deviceId, { deviceStopped });
  } catch (error) {
    // The contract says it never rejects; a broken fake or applier must not mask the caller's outcome.
    logger.warn(
      `[AndroidAuto] stopping the Desktop Head Unit for ${device.deviceId} failed: ${errorMessage(error)}`,
      error,
    );
  }
}
