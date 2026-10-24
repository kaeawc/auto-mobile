import { type BootedDevice } from "../../../models";
import { logger } from "../../../utils/logger";
import { teardownProbeBudget, type TeardownContext } from "./teardownContracts";

/**
 * What a named teardown learned about booted emulators another daemon owns, whose names
 * discovery deliberately does not read (so they list as `Unknown (<serial>)`, #15194).
 */
export type ForeignRuntimeProbeOutcome =
  | { kind: "clear" }
  | { kind: "unresolved"; runtime: BootedDevice }
  | { kind: "runs-target"; runtime: BootedDevice; avdName: string };

/**
 * Settle unnamed foreign emulators with one console read each, within the teardown's own deadline.
 * A runtime is `clear` only when it names an AVD that is neither the target's stable id nor its
 * stable name; an unanswered read, an exhausted budget, or the target's own name is not. Reading is
 * the only evidence: the placeholder alone proves nothing about which AVD the serial is running,
 * and a serial can be reused between two reads, so callers re-ask before each destructive step.
 */
export async function probeForeignUnnamedRuntimes(
  context: TeardownContext,
  runtimes: readonly BootedDevice[],
): Promise<ForeignRuntimeProbeOutcome> {
  const targetNames = new Set(
    [context.args.target.stableId, context.args.target.stableName].filter(
      (name): name is string => name !== undefined,
    ),
  );
  for (const runtime of runtimes) {
    const budget = teardownProbeBudget(context);
    const avdName =
      budget.remainingMs > 0
        ? await context.dependencies.resolveRunningAndroidAvdName(
            runtime,
            budget.remainingMs,
            budget.signal,
          )
        : undefined;
    if (avdName === undefined) {
      return { kind: "unresolved", runtime };
    }
    if (targetNames.has(avdName)) {
      return { kind: "runs-target", runtime, avdName };
    }
    logger.info(
      `[DeviceTools] Foreign emulator ${runtime.deviceId} runs '${avdName}', not teardown target ` +
        `'${context.args.target.stableId}'`,
    );
  }
  return { kind: "clear" };
}
