import { defaultTimer, type Timer } from "./SystemTimer";
import type {
  ProvisionedDeviceTransportFence,
  ProvisionedDeviceTransportTombstoneStore,
  RetiredProvisionedDeviceTransport,
} from "./provisionedDeviceTransportFence";
import { InMemoryProvisionedDeviceTransportFence } from "./InMemoryProvisionedDeviceTransportFence";

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
