import { ActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { IOS_CTRL_PROXY_RESERVED_PORTS, PortManager } from "../../../utils/PortManager";
import type { PrototypeAgentConnections } from "./iosPrototypeTransport";
import { type PrototypeAgentClient } from "./prototypeAgentClient";
import type { PrototypeAgentPortAllocator, PrototypeAgentRecord } from "./prototypeAgentInjection";

/** `PortManager` keyed per device and bundle id, skipping the fixed iOS SDK port. */
export const portManagerPrototypeAgentPorts: PrototypeAgentPortAllocator = {
  allocate: (key) => PortManager.allocate(key, { reservedPorts: IOS_CTRL_PROXY_RESERVED_PORTS }),
  release: (key) => PortManager.release(key),
};

export function prototypeAgentKey(deviceId: string, bundleId: string): string {
  return `prototype-agent:${deviceId}:${bundleId}`;
}

/**
 * The recorded agent connections. A record is dropped, its connection closed and its port
 * released when the app is terminated, the session or device is released, the app is relaunched
 * with prototype injection, or the agent closes the connection (the app exited).
 */
export class PrototypeAgentRegistry implements PrototypeAgentConnections {
  /** Insertion-ordered: the newest registration on a device is its last entry. */
  private readonly records = new Map<string, PrototypeAgentRecord>();

  constructor(
    private readonly ports: PrototypeAgentPortAllocator = portManagerPrototypeAgentPorts,
  ) {}

  /**
   * The device's current open agent connection: the most recent `launchApp {prototype: true}`
   * on it whose connection is still open (closed connections are dropped at once).
   */
  get(deviceId: string): PrototypeAgentClient | undefined {
    let current: PrototypeAgentRecord | undefined;
    for (const record of this.records.values()) {
      if (record.deviceId === deviceId) {
        current = record;
      }
    }
    return current?.client;
  }

  getRecord(deviceId: string, bundleId: string): PrototypeAgentRecord | undefined {
    return this.records.get(prototypeAgentKey(deviceId, bundleId));
  }

  /** The recorded agent, or an error that tells the caller how to get one. */
  require(deviceId: string, bundleId: string): PrototypeAgentRecord {
    const record = this.getRecord(deviceId, bundleId);
    if (record === undefined) {
      throw new ActionableError(
        `No prototype agent is recorded for ${bundleId} on ${deviceId}. Relaunch with launchApp ` +
          "{prototype: true}; the relaunch restarts the app and loses its state.",
      );
    }
    return record;
  }

  register(record: PrototypeAgentRecord): void {
    const key = prototypeAgentKey(record.deviceId, record.bundleId);
    const previous = this.records.get(key);
    // Delete before set so the new record becomes the device's newest entry.
    this.records.delete(key);
    if (previous !== undefined && previous.client !== record.client) {
      // The port belongs to the new record now; close only the old connection.
      previous.client.close();
    }
    this.records.set(key, record);
    record.client.onClosed((error) => {
      if (this.records.get(key)?.client === record.client) {
        logger.info(`[prototype-agent] ${record.bundleId} on ${record.deviceId} disconnected`, {
          reason: errorMessage(error),
        });
        this.records.delete(key);
        this.ports.release(key);
      }
    });
  }

  /**
   * Drops the record and closes its connection. The port is released too unless `keepPort` is
   * set: a relaunch reuses the keyed allocation because the old process still holds the listener
   * until the cold launch terminates it.
   */
  release(deviceId: string, bundleId: string, options: { keepPort?: boolean } = {}): void {
    const key = prototypeAgentKey(deviceId, bundleId);
    const record = this.records.get(key);
    if (record === undefined) {
      return;
    }
    this.records.delete(key);
    if (options.keepPort !== true) {
      this.ports.release(key);
    }
    record.client.close();
  }

  releaseDevice(deviceId: string): void {
    for (const record of [...this.records.values()]) {
      if (record.deviceId === deviceId) {
        this.release(record.deviceId, record.bundleId);
      }
    }
  }

  releaseAll(): void {
    for (const record of [...this.records.values()]) {
      this.release(record.deviceId, record.bundleId);
    }
  }

  size(): number {
    return this.records.size;
  }
}
