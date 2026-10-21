import { ActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { MAX_SETTIMEOUT_DELAY_MS, type Timer } from "../../../utils/SystemTimer";
import { diffDeviceBaseline } from "./baseline";
import { planDeviceMutationRevert, type DeviceMutationRevertSupport } from "./revertPlanner";
import type {
  DeviceBaseline,
  DeviceMutationInput,
  DeviceMutationJournal,
  DeviceMutationScope,
} from "./types";

export interface DeviceMutationResetContext {
  scope: DeviceMutationScope;
  signal: AbortSignal;
  assertOwned(): Promise<void>;
}

export interface DeviceMutationResetPort extends DeviceMutationRevertSupport {
  capture(context: DeviceMutationResetContext): Promise<DeviceBaseline>;
  revert(mutation: DeviceMutationInput, context: DeviceMutationResetContext): Promise<void>;
}

export type DeviceMutationResetResult =
  | { status: "clean" }
  | {
      status: "non_clean";
      reason: "baseline_missing" | "non_revertible" | "verification_failed" | "reset_failed";
      details: readonly string[];
    };

export interface DeviceMutationResetOptions {
  scope: DeviceMutationScope;
  journal: Pick<DeviceMutationJournal, "list" | "getBaseline">;
  port: DeviceMutationResetPort;
  assertOwned(): Promise<void>;
  timer: Pick<Timer, "setTimeout" | "clearTimeout">;
  budgetMs: number;
}

export async function revertDeviceMutations(
  options: DeviceMutationResetOptions,
): Promise<DeviceMutationResetResult> {
  if (
    !Number.isFinite(options.budgetMs) ||
    options.budgetMs <= 0 ||
    options.budgetMs > MAX_SETTIMEOUT_DELAY_MS
  ) {
    throw new ActionableError("Device mutation reset requires a finite, positive total budget");
  }
  const controller = new AbortController();
  const context: DeviceMutationResetContext = {
    scope: { ...options.scope },
    signal: controller.signal,
    assertOwned: async () => {
      controller.signal.throwIfAborted();
      await options.assertOwned();
      controller.signal.throwIfAborted();
    },
  };
  try {
    return await raceWithDeadline(() => runRevert(options, context), {
      timer: options.timer,
      timeoutMs: options.budgetMs,
      label: "Device mutation reset",
      onTimeout: () =>
        controller.abort(new ActionableError("Device mutation reset budget exceeded")),
    });
  } catch (error) {
    controller.abort(error);
    logger.warn(
      `Device mutation reset failed on ${options.scope.deviceId}: ${errorMessage(error)}`,
      error,
    );
    return { status: "non_clean", reason: "reset_failed", details: [errorMessage(error)] };
  }
}

async function runRevert(
  options: DeviceMutationResetOptions,
  context: DeviceMutationResetContext,
): Promise<DeviceMutationResetResult> {
  await context.assertOwned();
  const baseline = await options.journal.getBaseline(context.scope);
  if (!baseline) {
    return { status: "non_clean", reason: "baseline_missing", details: [] };
  }
  const entries = await options.journal.list(context.scope);
  await context.assertOwned();
  const current = await options.port.capture(context);
  const plan = planDeviceMutationRevert(
    entries,
    diffDeviceBaseline(baseline, current, entries),
    options.port,
  );
  if (plan.status === "non_revertible") {
    return { status: "non_clean", reason: "non_revertible", details: plan.reasons };
  }
  for (const step of plan.steps) {
    await context.assertOwned();
    await options.port.revert(step.mutation, context);
  }
  await context.assertOwned();
  const verified = diffDeviceBaseline(baseline, await options.port.capture(context));
  await context.assertOwned();
  return verified.dirty.length === 0 && verified.changes.length === 0
    ? { status: "clean" }
    : {
        status: "non_clean",
        reason: "verification_failed",
        details: [
          ...verified.dirty,
          ...verified.changes.map((change) => `${change.kind}:${change.key}`),
        ],
      };
}

export async function captureFirstDeviceBaseline(
  journal: Pick<DeviceMutationJournal, "getBaseline" | "captureBaseline">,
  port: Pick<DeviceMutationResetPort, "capture">,
  context: DeviceMutationResetContext,
): Promise<void> {
  context.signal.throwIfAborted();
  await context.assertOwned();
  if (await journal.getBaseline(context.scope)) {
    return;
  }
  const baseline = await port.capture(context);
  await context.assertOwned();
  context.signal.throwIfAborted();
  await journal.captureBaseline(context.scope, baseline);
}
