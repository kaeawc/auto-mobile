import { genericBaselineRevert, type BaselineDiff, type BaselineChange } from "./baseline";
import { DEVICE_MUTATION_KINDS, type DeviceMutationEntry, type DeviceMutationInput } from "./types";

export interface DeviceRevertStep {
  source: "journal" | "baseline";
  mutation: DeviceMutationInput;
}

export type DeviceRevertPlan =
  | { status: "revertible"; steps: readonly DeviceRevertStep[] }
  | { status: "non_revertible"; reasons: readonly string[] };

export interface DeviceMutationRevertSupport {
  canRevert(mutation: DeviceMutationInput): boolean;
  baselineRevert?(
    change: BaselineChange,
    changes: readonly BaselineChange[],
  ): DeviceMutationInput | null;
}

export function planDeviceMutationRevert(
  entries: readonly DeviceMutationEntry[],
  diff: BaselineDiff,
  support: DeviceMutationRevertSupport,
): DeviceRevertPlan {
  const knownKinds = new Set<string>(DEVICE_MUTATION_KINDS);
  const reasons = [...diff.dirty];
  const steps: DeviceRevertStep[] = [...entries]
    .sort((left, right) => right.sequence - left.sequence)
    .map((mutation) => ({ source: "journal", mutation }));
  for (const change of diff.changes.filter((entry) => !entry.journaled)) {
    const mutation =
      support.baselineRevert?.(change, diff.changes) ?? genericBaselineRevert(change);
    if (mutation) {
      if (
        !steps.some(
          (step) => step.mutation.kind === mutation.kind && step.mutation.key === mutation.key,
        )
      ) {
        steps.push({ source: "baseline", mutation });
      }
    } else {
      reasons.push(`Unjournaled ${change.kind}:${change.key}`);
    }
  }
  for (const step of steps) {
    if (step.mutation.priorValue.state === "unobservable") {
      reasons.push(`Unobservable prior value ${step.mutation.kind}:${step.mutation.key}`);
      continue;
    }
    if (!knownKinds.has(step.mutation.kind) || !support.canRevert(step.mutation)) {
      reasons.push(`Unsupported ${step.mutation.kind}:${step.mutation.key}`);
    }
  }
  return reasons.length > 0
    ? { status: "non_revertible", reasons }
    : { status: "revertible", steps };
}
