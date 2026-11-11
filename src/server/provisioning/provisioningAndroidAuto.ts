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
    /** Records the device once this run's own DHU connected, so a failed provision stops it. */
    settlementState?: Pick<ProvisionSettlementState, "androidAutoDevice">;
  },
): Promise<AndroidAutoProvisionReport | undefined> {
  const options = args.androidAuto;
  if (!options || device.platform !== "android") {
    return undefined;
  }
  signal.throwIfAborted();
  const applier = androidAutoApplier(deps);
  // Set only once this run's own DHU connected: a failed rerun must not stop a DHU an earlier
  // provision started and this run merely reused (the provisioner already stops one it applied
  // and then failed on).
  let ownsDesktopHeadUnit = false;
  return await runProvisionDeviceWithinDeadline(deps.timer, totalDeadlineMs, signal, {
    phase: "setting up Android Auto projection",
    operation: async (operationSignal) => {
      const report = await applier.apply(device, options, operationSignal);
      if (startedDesktopHeadUnit(report)) {
        ownsDesktopHeadUnit = true;
        if (settlementState) {
          settlementState.androidAutoDevice = device;
        }
      }
      return report;
    },
    // A run that outlives the deadline may still connect its own DHU; stop it once the run
    // settles. A run that rejects already stopped any DHU it applied, and a reused one stays.
    onPendingSettlement: (settlement) => {
      void settlement.then(
        async () => {
          if (ownsDesktopHeadUnit) {
            await applier.stopDesktopHeadUnit(device.deviceId);
          }
        },
        (error: unknown) => {
          // The provision already failed on the deadline; this late rejection has no caller.
          logger.debug(
            `[AndroidAuto] late projection run for ${device.deviceId} failed: ${errorMessage(error)}`,
          );
        },
      );
    },
  });
}

function startedDesktopHeadUnit(report: AndroidAutoProvisionReport): boolean {
  return report.steps.some(
    (step) => step.step === "desktop-head-unit" && step.status === "applied",
  );
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
