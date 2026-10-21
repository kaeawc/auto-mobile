import type {
  DeviceMutationResetContext,
  DeviceMutationResetPort,
} from "../../src/daemon/sessionBroker/mutations/reset";
import type {
  DeviceBaseline,
  DeviceMutationInput,
} from "../../src/daemon/sessionBroker/mutations/types";

export class FakeDeviceMutationResetPort implements DeviceMutationResetPort {
  get certifiableKinds(): readonly string[] {
    return this.snapshot.completeKinds;
  }
  readonly reverted: DeviceMutationInput[] = [];
  readonly unsupportedKinds = new Set<string>();
  captureCount = 0;
  ignoreWrites = false;
  beforeWrite: (() => Promise<void>) | null = null;

  constructor(public snapshot: DeviceBaseline) {}

  canRevert(mutation: DeviceMutationInput): boolean {
    return !this.unsupportedKinds.has(mutation.kind);
  }

  async capture(context: DeviceMutationResetContext): Promise<DeviceBaseline> {
    await context.assertOwned();
    this.captureCount++;
    return structuredClone(this.snapshot);
  }

  async revert(mutation: DeviceMutationInput, context: DeviceMutationResetContext): Promise<void> {
    await this.beforeWrite?.();
    await context.assertOwned();
    this.reverted.push(structuredClone(mutation));
    if (this.ignoreWrites) {
      return;
    }
    this.snapshot.observations = this.snapshot.observations.filter(
      (observation) => observation.kind !== mutation.kind || observation.key !== mutation.key,
    );
    if (mutation.priorValue.state === "present") {
      this.snapshot.observations.push({
        kind: mutation.kind,
        key: mutation.key,
        value: structuredClone(mutation.priorValue),
      });
    }
  }
}
