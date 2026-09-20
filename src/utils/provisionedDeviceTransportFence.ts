import { DeviceLostError } from "../daemon/emulatorLossIncident";
import {
  type RetiredProvisionedDeviceTransport,
  ProvisionedDeviceTransportTombstoneRepository,
  type ProvisionedDeviceTransportTombstoneStore,
} from "../db/provisionedDeviceTransportTombstoneRepository";
import { defaultTimer, type Timer } from "./SystemTimer";

export interface ProvisionedDeviceTransportFence {
  retire(input: RetiredProvisionedDeviceTransport): Promise<void>;
  get(deviceId: string): Promise<RetiredProvisionedDeviceTransport | undefined>;
}

export class InMemoryProvisionedDeviceTransportFence implements ProvisionedDeviceTransportFence {
  private readonly retired = new Map<string, RetiredProvisionedDeviceTransport>();

  async retire(input: RetiredProvisionedDeviceTransport): Promise<void> {
    this.retired.set(input.deviceId, { ...input });
  }

  async get(deviceId: string): Promise<RetiredProvisionedDeviceTransport | undefined> {
    const retired = this.retired.get(deviceId);
    return retired ? { ...retired } : undefined;
  }
}

export class DurableProvisionedDeviceTransportFence implements ProvisionedDeviceTransportFence {
  constructor(
    private readonly store: ProvisionedDeviceTransportTombstoneStore,
    private readonly memory: ProvisionedDeviceTransportFence = new InMemoryProvisionedDeviceTransportFence(),
    private readonly timer: Pick<Timer, "now"> = defaultTimer,
  ) {}

  async retire(input: RetiredProvisionedDeviceTransport): Promise<void> {
    await this.store.retire(input, this.timer.now());
    await this.memory.retire(input);
  }

  async get(deviceId: string): Promise<RetiredProvisionedDeviceTransport | undefined> {
    return (await this.memory.get(deviceId)) ?? (await this.store.get(deviceId));
  }
}

function createDefaultFence(): ProvisionedDeviceTransportFence {
  return process.env.NODE_ENV === "test"
    ? new InMemoryProvisionedDeviceTransportFence()
    : new DurableProvisionedDeviceTransportFence(
        new ProvisionedDeviceTransportTombstoneRepository(),
      );
}

let defaultFence: ProvisionedDeviceTransportFence = createDefaultFence();

export function getProvisionedDeviceTransportFence(): ProvisionedDeviceTransportFence {
  return defaultFence;
}

export async function throwIfProvisionedDeviceTransportRetired(deviceId: string): Promise<void> {
  const retired = await defaultFence.get(deviceId);
  if (!retired) {
    return;
  }
  throw new DeviceLostError(
    deviceId,
    `Provisioned Android device '${retired.stableId}' was removed after ${retired.reason}; ` +
      `transport '${deviceId}' is retired and cannot identify a later emulator.`,
  );
}

export function setProvisionedDeviceTransportFenceForTests(
  fence: ProvisionedDeviceTransportFence,
): void {
  defaultFence = fence;
}

export function resetProvisionedDeviceTransportFenceForTests(): void {
  defaultFence = new InMemoryProvisionedDeviceTransportFence();
}
