import { logger } from "../../../utils/logger";
import { opaqueIntentKey } from "./types";
import type {
  DeviceBaseline,
  DeviceMutationInput,
  DeviceMutationJournal,
  DeviceMutationScope,
  MutationValue,
} from "./types";
import { assertDeviceMutationScope } from "./types";
import { ActionableError } from "../../../models/ActionableError";
import { mutationIncarnation } from "./incarnation";

/** The scope a broker session's mutation recorder binds, per platform. */
export function brokerSessionMutationScope(input: {
  platform: string;
  sessionUuid: string;
  resource: { resourceId: string; scopeKey: string; allocationIndex: number };
  stableDeviceId: string;
  transportId?: string | null;
  assignmentGeneration: number | null;
  bootId?: string | null;
}): DeviceMutationScope {
  const { resource, stableDeviceId } = input;
  if (
    input.platform !== "ios" &&
    (!resource.resourceId.trim() ||
      input.assignmentGeneration === null ||
      !Number.isSafeInteger(input.assignmentGeneration) ||
      input.assignmentGeneration < 0)
  ) {
    throw new ActionableError(
      "Broker mutation recording requires an exact resource and assignment generation",
    );
  }
  return input.platform === "ios"
    ? {
        sessionUuid: input.sessionUuid,
        deviceId: stableDeviceId,
        incarnation: mutationIncarnation({
          platform: "ios",
          scopeKey: resource.scopeKey,
          allocationIndex: resource.allocationIndex,
          stableDeviceId,
        }),
      }
    : {
        sessionUuid: input.sessionUuid,
        deviceId: input.transportId ?? stableDeviceId,
        incarnation: mutationIncarnation({
          platform: "android",
          resourceId: resource.resourceId,
          stableDeviceId,
          bootId: input.bootId ?? null,
        }),
      };
}

export interface MutationRecorder {
  readonly scope: Readonly<DeviceMutationScope>;
  record(mutation: DeviceMutationInput): Promise<void>;
  /** Never throws: best-effort persistence that logs its own failure. */
  markUnrecorded(toolName: string): Promise<void>;
  missingMutations(
    mutations: readonly Pick<DeviceMutationInput, "kind" | "key">[],
  ): Promise<Pick<DeviceMutationInput, "kind" | "key">[]>;
  baselinePrior(kind: string, key: string): Promise<MutationValue>;
  /** The device baseline this session started from, when the recorder can read it. */
  readBaseline?(): Promise<DeviceBaseline | null>;
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

  async markUnrecorded(toolName: string): Promise<void> {
    try {
      await this.record({
        kind: "opaque",
        key: opaqueIntentKey("recording-failed", toolName),
        priorValue: { state: "unobservable" },
        toolName,
      });
    } catch (error) {
      logger.warn("Cannot persist device mutation recording failure marker", error);
    }
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

  readBaseline(): Promise<DeviceBaseline | null> {
    return this.journal.getBaseline(this.scope);
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
