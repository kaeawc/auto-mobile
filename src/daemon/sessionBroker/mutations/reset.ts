import { ActionableError, toActionableError } from "../../../models/ActionableError";
import { combineAbortSignals } from "../../../utils/AbortContext";
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
import { DEVICE_MUTATION_KINDS } from "./types";

export interface DeviceMutationResetContext {
  deadlineMs?: number;
  scope: DeviceMutationScope;
  signal: AbortSignal;
  assertOwned(): Promise<void>;
  recordPhase?: (phase: string, durationMs: number) => void;
  baseline?: DeviceBaseline;
}

export interface DeviceMutationResetPort extends DeviceMutationRevertSupport {
  readonly certifiableKinds?: readonly string[];
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
  signal?: AbortSignal;
  propagateErrors?: boolean;
  afterRevert?: (context: DeviceMutationResetContext) => Promise<void>;
  recordPhase?: (phase: string, durationMs: number) => void;
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
    signal: combineAbortSignals(controller.signal, options.signal) ?? controller.signal,
    recordPhase: options.recordPhase,
    assertOwned: async () => {
      context.signal.throwIfAborted();
      await options.assertOwned();
      context.signal.throwIfAborted();
    },
  };
  try {
    return await raceWithDeadline(() => runRevert(options, context), {
      timer: options.timer,
      signal: context.signal,
      timeoutMs: options.budgetMs,
      label: "Device mutation reset",
      onTimeout: () =>
        controller.abort(new DOMException("Device mutation reset budget exceeded", "TimeoutError")),
    });
  } catch (error) {
    controller.abort(error);
    logger.warn(
      `Device mutation reset failed on ${options.scope.deviceId}: ${errorMessage(error)}`,
      error,
    );
    if (options.propagateErrors) {
      throw toActionableError(context.signal.reason ?? error, "Device mutation reset failed");
    }
    return { status: "non_clean", reason: "reset_failed", details: [errorMessage(error)] };
  }
}

async function runRevert(
  options: DeviceMutationResetOptions,
  context: DeviceMutationResetContext,
): Promise<DeviceMutationResetResult> {
  const baseline = await options.journal.getBaseline(context.scope);
  if (!baseline) {
    return { status: "non_clean", reason: "baseline_missing", details: [] };
  }
  context.baseline = baseline;
  const incomplete = DEVICE_MUTATION_KINDS.filter(
    (kind) =>
      !baseline.completeKinds.includes(kind) ||
      (options.port.certifiableKinds !== undefined &&
        !options.port.certifiableKinds.includes(kind)),
  );
  if (baseline.unobservable.length > 0 || incomplete.length > 0) {
    return {
      status: "non_clean",
      reason: "non_revertible",
      details: [...baseline.unobservable, ...incomplete],
    };
  }
  await context.assertOwned();
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
  await options.afterRevert?.(context);
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
  if (baseline.completeKinds.length === 0 && baseline.observations.length === 0) {
    throw new ActionableError("Device baseline capture returned no observable inventory");
  }
  await journal.captureBaseline(context.scope, baseline);
}
