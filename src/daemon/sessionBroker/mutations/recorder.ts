import type {
  DeviceMutationInput,
  DeviceMutationJournal,
  DeviceMutationScope,
  MutationValue,
} from "./types";
import { assertDeviceMutationScope } from "./types";
import { ActionableError } from "../../../models/ActionableError";

export function brokerMutationIncarnation(
  resourceId: string,
  assignmentGeneration: number | null,
): string {
  if (
    !resourceId.trim() ||
    assignmentGeneration === null ||
    !Number.isSafeInteger(assignmentGeneration) ||
    assignmentGeneration < 0
  ) {
    throw new ActionableError(
      "Broker mutation recording requires an exact resource and assignment generation",
    );
  }
  return JSON.stringify([resourceId, assignmentGeneration]);
}

/**
 * The iOS journal incarnation: one pooled slot's simulator, stable across the sessions that reuse
 * it, so the first captured baseline stays the reset target. The recorder must bind this same
 * scope, or the keep-booted reset lists none of the session's rows and reverts nothing (#14790).
 */
export function brokerIosMutationIncarnation(
  resource: { scopeKey: string; allocationIndex: number },
  stableDeviceId: string,
): string {
  return JSON.stringify([resource.scopeKey, resource.allocationIndex, stableDeviceId]);
}

export interface MutationRecorder {
  readonly scope: Readonly<DeviceMutationScope>;
  record(mutation: DeviceMutationInput): Promise<void>;
  missingMutations(
    mutations: readonly Pick<DeviceMutationInput, "kind" | "key">[],
  ): Promise<Pick<DeviceMutationInput, "kind" | "key">[]>;
  baselinePrior(kind: string, key: string): Promise<MutationValue>;
}

export class SessionMutationRecorder implements MutationRecorder {
  readonly scope: Readonly<DeviceMutationScope>;

  constructor(
    private readonly journal: Pick<DeviceMutationJournal, "record" | "list" | "getBaseline">,
    scope: DeviceMutationScope,
  ) {
    assertDeviceMutationScope(scope, scope.sessionUuid);
    this.scope = Object.freeze({ ...scope });
  }

  record(mutation: DeviceMutationInput): Promise<void> {
    return this.journal.record(this.scope, mutation);
  }

  async missingMutations(
    mutations: readonly Pick<DeviceMutationInput, "kind" | "key">[],
  ): Promise<Pick<DeviceMutationInput, "kind" | "key">[]> {
    const entries = await this.journal.list(this.scope);
    const recorded = new Set(entries.map((entry) => JSON.stringify([entry.kind, entry.key])));
    return mutations.filter(
      (mutation) => !recorded.has(JSON.stringify([mutation.kind, mutation.key])),
    );
  }

  async baselinePrior(kind: string, key: string): Promise<MutationValue> {
    const baseline = await this.journal.getBaseline(this.scope);
    if (!baseline?.completeKinds.includes(kind) || baseline.unobservable.includes(kind)) {
      return { state: "unobservable" };
    }
    return (
      baseline.observations.find((entry) => entry.kind === kind && entry.key === key)?.value ?? {
        state: "absent",
      }
    );
  }
}
