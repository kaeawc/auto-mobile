import type {
  ProvisionedDeviceTransportFence,
  RetiredProvisionedDeviceTransport,
} from "./provisionedDeviceTransportFence";

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
