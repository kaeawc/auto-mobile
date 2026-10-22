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
 * The incarnation an iOS pool entry's mutation journal rows and baseline share. A session's
 * journal rows must carry the same incarnation as the keep-booted reset scope, or the reset reads
 * an empty journal and never reverts what the session changed (#14790).
 */
export function iosMutationIncarnation(
  scopeKey: string,
  allocationIndex: number,
  stableDeviceId: string,
): string {
  return JSON.stringify([scopeKey, allocationIndex, stableDeviceId]);
}

/** The scope a broker session's mutation recorder binds, per platform. */
export function brokerSessionMutationScope(input: {
  platform: string;
  sessionUuid: string;
  resource: { resourceId: string; scopeKey: string; allocationIndex: number };
  stableDeviceId: string;
  transportId?: string | null;
  assignmentGeneration: number | null;
}): DeviceMutationScope {
  const { resource, stableDeviceId } = input;
  return input.platform === "ios"
    ? {
        sessionUuid: input.sessionUuid,
        deviceId: stableDeviceId,
        incarnation: iosMutationIncarnation(
          resource.scopeKey,
          resource.allocationIndex,
          stableDeviceId,
        ),
      }
    : {
        sessionUuid: input.sessionUuid,
        deviceId: input.transportId ?? stableDeviceId,
        incarnation: brokerMutationIncarnation(resource.resourceId, input.assignmentGeneration),
      };
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
