import { ActionableError } from "../../../models";
import { deviceReservedForRestartRecoveryError } from "../../../daemon/inputDeviceOwnership";
import { lifecycleRequester } from "../lifecycleRequester";
import { type StableDeviceTarget } from "../core/deadlines";
import { type StartDeviceArgs, type StartDeviceSessionArgs } from "../core/contracts";
import { initializedDevicePool } from "../core/dependencies";

/** Mutable holder for the acquisition stage currently in flight. */
export type AcquisitionStage = { current: string };

export type DevicePreparationBudgets = {
  bootTimeoutMs: number;
  automationReadyTimeoutMs: number;
  automationDeadlineMs: number;
  operationName: string;
  androidAvdName?: string;
  stableTarget?: StableDeviceTarget;
  /** Android `avdName` + `deviceId` pair, validated before and after discovery. */
  requestedAndroidIdentifierPair?: { avdName: string; deviceId: string };
  /** Running preparation stage, named when the acquisition deadline backstop fires (#6034). */
  stage?: AcquisitionStage;
};

export function setAcquisitionStage(budgets: DevicePreparationBudgets, stage: string): void {
  if (budgets.stage) {
    budgets.stage.current = stage;
  }
}

/**
 * Acquisition-phase timeout. `reserveStableDeviceLifecycle` defaults to the
 * killDevice-shaped `shutdownTimeoutError`, which on a start path reports the
 * device as failing to *disappear*, quotes `DEVICE_SHUTDOWN_TIMEOUT_MS`
 * instead of the caller's budget, and tells the user to verify the shutdown
 * state. Mirror the phase-labeled style `DeviceBootService` already emits.
 */
export const acquisitionLifecycleTimeoutError = (
  budgets: DevicePreparationBudgets,
  describedTarget: string,
  detail: string,
): ActionableError =>
  new ActionableError(
    `${budgets.operationName} timeout exhausted while ${detail}; ` +
      `budgetMs=${budgets.bootTimeoutMs + budgets.automationReadyTimeoutMs}; ` +
      `target=${describedTarget}; origin=virtualDeviceLifecycleCoordinator`,
  );

/** Check exact identities before lifecycle waiting, and retain the admitted owner across boot. */
export function admitRestartReservedStart(args: StartDeviceArgs): void {
  const reservation = initializedDevicePool()?.restartReservationForStart?.(
    args.platform,
    [args.avdName, args.matchExactName ? args.name : undefined, args.deviceId].filter(
      (id): id is string => id !== undefined,
    ),
    startRequester(args),
  );
  if (!reservation) {
    return;
  }
  if (!reservation.owned) {
    throw deviceReservedForRestartRecoveryError(
      reservation.deviceId,
      reservation.sessionUuid,
      reservation.retryAfterMs,
    );
  }
  if (reservation.restartHandoff) {
    args.__restartResumeSessionUuid ??= reservation.sessionUuid;
    args.__restartResumeTargets ??= initializedDevicePool()?.restartReservationExclusions(
      args.platform,
      startRequester(args),
    ).resumeTargets;
  }
}

export function startRequester(args: StartDeviceSessionArgs) {
  const requester = lifecycleRequester(args);
  return {
    ...requester,
    sessionUuid: args.__requesterSessionUuid ?? requester.sessionUuid,
    oneShotCli: args.__oneShotCli,
  };
}
