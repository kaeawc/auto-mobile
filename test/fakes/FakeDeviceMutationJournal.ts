import {
  assertDeviceMutationScope,
  deviceBaselineSchema,
  mutationValueSchema,
  type DeviceBaseline,
  type DeviceIncarnationScope,
  type DeviceMutationEntry,
  type DeviceMutationInput,
  type DeviceMutationJournal,
  type DeviceMutationScope,
} from "../../src/daemon/sessionBroker/mutations/types";
import type { Timer } from "../../src/utils/SystemTimer";

export class FakeDeviceMutationJournal implements DeviceMutationJournal {
  private readonly entries = new Map<string, DeviceMutationEntry[]>();
  private readonly baselines = new Map<string, DeviceBaseline>();
  private sequence = 0;

  constructor(private readonly timer: Pick<Timer, "now">) {}

  async record(scope: DeviceMutationScope, mutation: DeviceMutationInput): Promise<void> {
    assertDeviceMutationScope(scope, scope.sessionUuid);
    const priorValue = mutationValueSchema.parse(mutation.priorValue);
    const scopeKey = this.sessionKey(scope);
    const entries = this.entries.get(scopeKey) ?? [];
    if (!entries.some((entry) => entry.kind === mutation.kind && entry.key === mutation.key)) {
      // Only the journal's columns are stored, as in SqliteDeviceMutationJournal.
      entries.push({
        kind: mutation.kind,
        key: mutation.key,
        toolName: mutation.toolName,
        priorValue: structuredClone(priorValue),
        sequence: ++this.sequence,
        appliedAt: this.timer.now(),
      });
      this.entries.set(scopeKey, entries);
    }
  }

  async list(scope: DeviceMutationScope): Promise<readonly DeviceMutationEntry[]> {
    return structuredClone(this.entries.get(this.sessionKey(scope)) ?? []);
  }

  async deleteSession(scope: DeviceMutationScope): Promise<void> {
    this.entries.delete(this.sessionKey(scope));
  }

  async captureBaseline(scope: DeviceIncarnationScope, baseline: DeviceBaseline): Promise<void> {
    const key = this.deviceKey(scope);
    const validated = deviceBaselineSchema.parse(baseline);
    if (!this.baselines.has(key)) {
      this.baselines.set(key, structuredClone(validated));
    }
  }

  async getBaseline(scope: DeviceIncarnationScope): Promise<DeviceBaseline | null> {
    return structuredClone(this.baselines.get(this.deviceKey(scope)) ?? null);
  }

  async deleteResource(resourceId: string): Promise<void> {
    const matches = (incarnation: string) => {
      if (incarnation === resourceId) {
        return true;
      }
      const identity: unknown = JSON.parse(incarnation.startsWith("[") ? incarnation : "null");
      return Array.isArray(identity) && identity[0] === resourceId;
    };
    for (const key of this.baselines.keys()) {
      const [, incarnation]: string[] = JSON.parse(key);
      if (matches(incarnation)) {
        this.baselines.delete(key);
      }
    }
    for (const key of this.entries.keys()) {
      const [, , incarnation]: string[] = JSON.parse(key);
      if (matches(incarnation)) {
        this.entries.delete(key);
      }
    }
  }

  private deviceKey(scope: DeviceIncarnationScope): string {
    assertDeviceMutationScope(scope);
    return JSON.stringify([scope.deviceId, scope.incarnation]);
  }

  private sessionKey(scope: DeviceMutationScope): string {
    assertDeviceMutationScope(scope, scope.sessionUuid);
    return JSON.stringify([scope.sessionUuid, scope.deviceId, scope.incarnation]);
  }
}
