import type { BootedDevice } from "../../models";
import { ProvisionDeviceError } from "../../devices/exactDeviceProvisioning";
import {
  defaultAndroidAutoProjectionApplier,
  existingDefaultAndroidAutoProjectionApplier,
  type AndroidAutoProjectionApplier,
  type AndroidAutoProvisionReport,
} from "../../features/androidAuto/AndroidAutoProjectionService";
import {
  runOperationWithinDeadline,
  runProvisionDeviceWithinDeadline,
  type DeviceToolsDependencies,
  type ProvisionDeviceArgs,
  type StartDeviceAndroidAutoOptions,
} from "../../features/deviceLifecycle/deviceLifecycleCore";
import { ActionableError } from "../../models/ActionableError";
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
  return await runOwnedProjection(androidAutoApplier(deps), device, {
    run: async (applier, operationSignal) => await applier.apply(device, options, operationSignal),
    within: async (operation, onPendingSettlement) =>
      await runProvisionDeviceWithinDeadline(deps.timer, totalDeadlineMs, signal, {
        phase: "setting up Android Auto projection",
        operation,
        onPendingSettlement,
      }),
    onOwnDesktopHeadUnit: () => {
      if (settlementState) {
        settlementState.androidAutoDevice = device;
      }
    },
  });
}

/**
 * startDevice's `androidAuto.headUnit` (#17840): start the DHU for the ready, session-bound
 * phone emulator through the same applier provisionDevice uses, bounded by the start's deadline
 * and abort signal. A run that outlives them and then connects its own DHU stops that DHU.
 */
export async function startDeviceAndroidAutoHeadUnit(
  options: StartDeviceAndroidAutoOptions,
  deps: Pick<DeviceToolsDependencies, "androidAutoProjection" | "timer">,
  device: BootedDevice,
  { signal, totalDeadlineMs }: { signal: AbortSignal | undefined; totalDeadlineMs: number },
): Promise<AndroidAutoProvisionReport> {
  return await runOwnedProjection(androidAutoApplier(deps), device, {
    run: async (applier, operationSignal) =>
      await applier.startHeadUnit(device, options, operationSignal),
    within: async (operation, onOrphan) =>
      await runOperationWithinDeadline(deps.timer, totalDeadlineMs, signal, {
        operation,
        onOrphan,
        timeoutError: () =>
          new ActionableError(
            `startDevice timed out starting the Android Auto head unit for ${device.deviceId}. The phone is ready and its session stays bound; raise timeoutMs and call startDevice again.`,
          ),
      }),
  });
}

type ProjectionRun = (
  applier: AndroidAutoProjectionApplier,
  signal: AbortSignal,
) => Promise<AndroidAutoProvisionReport>;

/**
 * One projection run within the caller's deadline. Ownership of the DHU is recorded only once
 * this run's own DHU connected: a failed rerun must not stop a DHU an earlier run started and
 * this one merely reused (the provisioner already stops one it applied and then failed on).
 */
async function runOwnedProjection(
  applier: AndroidAutoProjectionApplier,
  device: BootedDevice,
  {
    run,
    within,
    onOwnDesktopHeadUnit,
  }: {
    run: ProjectionRun;
    within: (
      operation: (signal: AbortSignal) => Promise<AndroidAutoProvisionReport>,
      onPendingSettlement: (settlement: Promise<unknown>) => void,
    ) => Promise<AndroidAutoProvisionReport>;
    onOwnDesktopHeadUnit?: () => void;
  },
): Promise<AndroidAutoProvisionReport> {
  let ownsDesktopHeadUnit = false;
  return await within(
    async (operationSignal) => {
      const report = await run(applier, operationSignal);
      if (startedDesktopHeadUnit(report)) {
        ownsDesktopHeadUnit = true;
        onOwnDesktopHeadUnit?.();
      }
      return report;
    },
    // A run that outlives the deadline may still connect its own DHU; stop it once the run
    // settles. A run that rejects already stopped any DHU it applied, and a reused one stays.
    (settlement) => {
      void settlement.then(
        async () => {
          if (ownsDesktopHeadUnit) {
            await applier.stopDesktopHeadUnit(device.deviceId);
          }
        },
        (error: unknown) => {
          // The request already failed on the deadline; this late rejection has no caller.
          logger.debug(
            `[AndroidAuto] late projection run for ${device.deviceId} failed: ${errorMessage(error)}`,
          );
        },
      );
    },
  );
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
): Promise<boolean> {
  if (device.platform !== "android") {
    return false;
  }
  const applier = deps.androidAutoProjection ?? existingDefaultAndroidAutoProjectionApplier();
  try {
    return (await applier?.stopDesktopHeadUnit(device.deviceId, { deviceStopped })) ?? false;
  } catch (error) {
    // The contract says it never rejects; a broken fake or applier must not mask the caller's outcome.
    logger.warn(
      `[AndroidAuto] stopping the Desktop Head Unit for ${device.deviceId} failed: ${errorMessage(error)}`,
      error,
    );
  }
  return false;
}
