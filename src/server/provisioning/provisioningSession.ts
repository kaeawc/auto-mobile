import {
  adoptRestartResumeSessionUuid,
  adoptRestartResumeTargets,
  internalMcpSessionId,
  internalOneShotCli,
  internalRestartResumeSessionUuid,
  internalRestartResumeTargets,
} from "../internalToolParams";
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
    __mcpSessionId: internalMcpSessionId(args),
    __restartResumeSessionUuid: internalRestartResumeSessionUuid(args),
    ...(internalOneShotCli(args) ? { __oneShotCli: true } : {}),
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
  sourceImage: DeviceInfo,
  binding: {
    timer: DeviceToolsDependencies["timer"];
    totalDeadlineMs: number;
    signal: AbortSignal;
    readinessReservation: DeviceReadinessReservation | undefined;
    settlementState: ProvisionSettlementState;
  },
): Promise<string> {
  const { readinessReservation, settlementState } = binding;
  return await runProvisionDeviceWithinDeadline(
    binding.timer,
    binding.totalDeadlineMs,
    binding.signal,
    "binding the device session",
    bindUndoneIfUndelivered(
      async (receipt, bindSignal) =>
        ctx.bindBootedDeviceSession(
          boot.device,
          provisionSessionArgs(args),
          sourceImage,
          boot.processHandle,
          // Our own stable-name readiness reservation must not deny our
          // own bind when the pooled incarnation changed during readiness.
          provisionSessionBindingOptions(
            args,
            readinessReservation,
            settlementState,
            receipt,
            bindSignal,
          ),
        ),
      () => boot,
    ),
    (settlement) => {
      settlementState.bindingSettlements.push(settlement);
    },
  );
}

function provisionSessionBindingOptions(
  args: ProvisionDeviceArgs,
  readinessReservation: DeviceReadinessReservation | undefined,
  settlementState: ProvisionSettlementState,
  receipt: AcquisitionReceipt,
  signal: AbortSignal,
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
