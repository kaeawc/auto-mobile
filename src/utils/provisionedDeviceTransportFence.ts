import { DeviceLostError } from "../models/DeviceLostError";
import { ActionableError } from "../models/ActionableError";
import { defaultTimer, type Timer } from "./SystemTimer";

export interface RetiredProvisionedDeviceTransport {
  deviceId: string;
  stableId: string;
  reason: string;
}

export interface ProvisionedDeviceTransportTombstoneStore {
  retire(input: RetiredProvisionedDeviceTransport, retiredAtMs: number): Promise<void>;
  get(deviceId: string): Promise<RetiredProvisionedDeviceTransport | undefined>;
  clear(deviceId: string): Promise<void>;
}

export interface ProvisionedDeviceTransportFence {
  retire(input: RetiredProvisionedDeviceTransport): Promise<void>;
  get(deviceId: string): Promise<RetiredProvisionedDeviceTransport | undefined>;
  /** Drops the tombstone once a different incarnation (or a deliberate boot) owns the serial. */
  clear(deviceId: string): Promise<void>;
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

  async clear(deviceId: string): Promise<void> {
    this.retired.delete(deviceId);
  }
}

export class DurableProvisionedDeviceTransportFence implements ProvisionedDeviceTransportFence {
  private readonly store: ProvisionedDeviceTransportTombstoneStore;
  private readonly memory: ProvisionedDeviceTransportFence;
  private readonly timer: Pick<Timer, "now">;

  constructor(options: {
    store: ProvisionedDeviceTransportTombstoneStore;
    memory?: ProvisionedDeviceTransportFence;
    timer?: Pick<Timer, "now">;
  }) {
    this.store = options.store;
    this.memory = options.memory ?? new InMemoryProvisionedDeviceTransportFence();
    this.timer = options.timer ?? defaultTimer;
  }

  async retire(input: RetiredProvisionedDeviceTransport): Promise<void> {
    await this.store.retire(input, this.timer.now());
    await this.memory.retire(input);
  }

  async get(deviceId: string): Promise<RetiredProvisionedDeviceTransport | undefined> {
    return (await this.memory.get(deviceId)) ?? (await this.store.get(deviceId));
  }

  async clear(deviceId: string): Promise<void> {
    await this.store.clear(deviceId);
    await this.memory.clear(deviceId);
  }
}

let defaultFence: ProvisionedDeviceTransportFence | undefined =
  process.env.NODE_ENV === "test" ? new InMemoryProvisionedDeviceTransportFence() : undefined;

/** Startup owns construction; repeated registration must preserve the process-wide fence. */
export function initializeProvisionedDeviceTransportFence(
  createFence: () => ProvisionedDeviceTransportFence,
): ProvisionedDeviceTransportFence {
  return (defaultFence ??= createFence());
}

export function getProvisionedDeviceTransportFence(): ProvisionedDeviceTransportFence {
  if (!defaultFence) {
    throw new ActionableError(
      "Provisioned device transport fence is not installed. Initialize the default fence during startup before using device sessions or provisioning.",
    );
  }
  return defaultFence;
}

export interface RetiredTransportCheckOptions {
  /**
   * Resolves the stable id (AVD name) of whatever is attached to the serial now, or undefined when
   * it cannot be determined. A different identity than the tombstone's proves a new incarnation.
   */
  currentIdentity?: () => Promise<string | undefined>;
}

export async function throwIfProvisionedDeviceTransportRetired(
  deviceId: string,
  options: RetiredTransportCheckOptions = {},
): Promise<void> {
  const fence = getProvisionedDeviceTransportFence();
  const retired = await fence.get(deviceId);
  if (!retired) {
    return;
  }
  const current = await options.currentIdentity?.();
  if (current && current !== retired.stableId) {
    await fence.clear(deviceId);
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

export function resetProvisionedDeviceTransportFenceForTests({
  isTest = true,
}: { isTest?: boolean } = {}): void {
  defaultFence = isTest ? new InMemoryProvisionedDeviceTransportFence() : undefined;
}
