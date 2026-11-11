import {
  adoptRestartResumeSessionUuid,
  adoptRestartResumeTargets,
  internalRestartResumeSessionUuid,
  internalRestartResumeTargets,
} from "../internalToolParams";
import { holdAcquiringSession } from "../../daemon/acquiringSessionHold";
import { executionTracker } from "../../daemon/executionTracker";
import { defaultDaemonContext } from "../../daemon/daemonContext";
import { captureAutolockPolicy } from "../../daemon/deviceAutolockPolicy";
import { DeviceInfo } from "../../models";
import { logger } from "../../utils/logger";
import { type AcquisitionReceipt } from "../../daemon/acquisitionReceipt";
import type { DeviceReadinessLevel } from "../../daemon/readiness/DeviceReadiness";
import type { DeviceReadinessReservation } from "../../daemon/devicePool";
import { type DeviceBootResult } from "../../devices/deviceBootService";
import {
  DeviceToolsDependencies,
  ProvisionDeviceArgs,
  StartDeviceArgs,
  admitRestartReservedStart,
  bindUndoneIfUndelivered,
  getDeviceToolsDependencies,
  runProvisionDeviceWithinDeadline,
} from "../../features/deviceLifecycle/deviceLifecycleCore";
import { type ProvisionSettlementState, type ProvisioningContext } from "./provisioningTypes";

export function provisionSessionArgs(args: ProvisionDeviceArgs): StartDeviceArgs {
  return {
    platform: args.device.platform,
    name: args.device.name,
    matchExactName: true,
    __restartResumeTargets: internalRestartResumeTargets(args),
    timeoutMs: args.timeoutMs,
    __restartResumeSessionUuid: internalRestartResumeSessionUuid(args),
  };
}

export function admitRestartReservedProvision(args: ProvisionDeviceArgs, deviceId?: string): void {
  const start = { ...provisionSessionArgs(args), deviceId };
  admitRestartReservedStart(start);
  adoptRestartResumeSessionUuid(args, internalRestartResumeSessionUuid(start));
  adoptRestartResumeTargets(args, internalRestartResumeTargets(start));
}

/**
 * Bind the provisioned device's session under the request deadline. A request cancelled while
 * the bind finishes gets no session id, so what the bind minted is released again (#11565).
 */
export async function bindProvisionedDeviceSession(
  ctx: ProvisioningContext,
  args: ProvisionDeviceArgs,
  boot: DeviceBootResult,
  {
    sourceImage,
    binding,
  }: {
    sourceImage: DeviceInfo;
    binding: {
      timer: DeviceToolsDependencies["timer"];
      totalDeadlineMs: number;
      signal: AbortSignal;
      readinessReservation: DeviceReadinessReservation | undefined;
      settlementState: ProvisionSettlementState;
    };
  },
): Promise<string> {
  const { readinessReservation, settlementState } = binding;
  return await runProvisionDeviceWithinDeadline(
    binding.timer,
    binding.totalDeadlineMs,
    binding.signal,
    {
      operation: bindUndoneIfUndelivered(
        async (receipt, bindSignal) =>
          ctx.bindBootedDeviceSession(boot.device, provisionSessionArgs(args), sourceImage, {
            childProcess: boot.processHandle,
            // Our own stable-name readiness reservation must not deny our
            // own bind when the pooled incarnation changed during readiness.
            ...provisionSessionBindingOptions(args, readinessReservation, settlementState, {
              receipt,
              signal: bindSignal,
            }),
          }),
        () => boot,
      ),
      phase: "binding the device session",
      onPendingSettlement: (settlement) => {
        settlementState.bindingSettlements.push(settlement);
      },
    },
  );
}

/**
 * Run an acquiring call's post-bind steps (provisionDevice's, startDevice's head unit) while
 * holding the session they work on (#17885). The
 * caller learns the session id only when the call returns, so nothing heartbeats it meanwhile;
 * the hold keeps it from the missing-first-heartbeat reap until `deadlineMs`, restarts the grace
 * when it ends, and is released before any rollback runs, so an abandoned session is still
 * reaped. The steps get the hold's signal, which aborts when the daemon cancels the session's
 * work (its device was lost).
 */
export async function whileHoldingProvisionedSession<T>(
  deps: Pick<DeviceToolsDependencies, "holdAcquiringSession">,
  {
    sessionUuid,
    deadlineMs,
    toolName = "provisionDevice",
  }: { sessionUuid: string; deadlineMs: number; toolName?: string },
  steps: (holdSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const hold =
    deps.holdAcquiringSession ??
    ((uuid: string, deadline: number) =>
      holdAcquiringSession(executionTracker, defaultDaemonContext.sessionManager(), {
        toolName,
        sessionUuid: uuid,
        deadlineMs: deadline,
      }));
  const { signal, release } = hold(sessionUuid, deadlineMs);
  try {
    return await steps(signal);
  } finally {
    release();
  }
}

function provisionSessionBindingOptions(
  args: ProvisionDeviceArgs,
  readinessReservation: DeviceReadinessReservation | undefined,
  settlementState: ProvisionSettlementState,
  { receipt, signal }: { receipt: AcquisitionReceipt; signal: AbortSignal },
) {
  return {
    receipt,
    signal,
    readinessReservationOwners: readinessReservation
      ? new Set([readinessReservation.owner])
      : undefined,
    verifiedAndroidAvdIdentity: undefined,
    autolockEnabled: captureAutolockPolicy(getDeviceToolsDependencies().env),
    achievedReadiness: resolveProvisionDeviceAchievedReadiness(args.readiness),
    collectCancellationSettlement: (settlement: Promise<void>) => {
      settlementState.bindingSettlements.push(settlement);
    },
  };
}

export function releaseProvisionReadiness(
  releaseReservation: DeviceReadinessReservation | undefined,
): void {
  // Session ownership is already committed on success. A delayed mutex-backed
  // reservation release must neither turn that success into destructive rollback
  // nor replace the original failure. Keep the balanced release queued.
  void releaseReservation?.().catch((error) =>
    logger.warn(`Provision readiness release failed: ${error}`),
  );
}

/**
 * The `DeviceReadinessLevel` actually achieved by `provisionDevice` for the
 * requested `readiness` option. `"automation"` runs `ensureCtrlProxyReady`
 * in `ensureProvisionDeviceReadiness` and reaches `automationReady`;
 * `"none"` deliberately skips that setup, leaving the device merely booted
 * (#6227 round 6).
 */
function resolveProvisionDeviceAchievedReadiness(
  readiness: ProvisionDeviceArgs["readiness"],
): DeviceReadinessLevel {
  return readiness === "automation" ? "automationReady" : "booted";
}
