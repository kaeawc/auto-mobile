import type { PrototypeAgentConnections } from "./iosPrototypeTransport";
import { type PrototypeAgentClient } from "./prototypeAgentClient";
import type { PrototypeViewerRecord } from "./prototypeViewerAttach";

/** One attached viewer per device; an old connection's close cannot remove its replacement. */
export class PrototypeViewerConnections implements PrototypeAgentConnections {
  private readonly records = new Map<string, PrototypeViewerRecord>();

  get(deviceId: string, bundleId?: string): PrototypeAgentClient | undefined {
    const record = this.records.get(deviceId);
    return bundleId === undefined || record?.bundleId === bundleId ? record?.client : undefined;
  }

  release(deviceId: string, bundleId?: string): void {
    const client = this.get(deviceId, bundleId);
    if (client !== undefined) {
      this.records.delete(deviceId);
      client.close();
    }
  }

  releaseDevice(deviceId: string): void {
    this.release(deviceId);
  }

  record(deviceId: string, record: PrototypeViewerRecord): void {
    const previous = this.records.get(deviceId);
    this.records.set(deviceId, record);
    record.client.onClosed(() => {
      if (this.records.get(deviceId) === record) {
        this.records.delete(deviceId);
      }
    });
    if (previous !== undefined && previous.client !== record.client) {
      previous.client.close();
    }
  }
}
