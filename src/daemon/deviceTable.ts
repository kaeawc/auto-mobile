import { holderOf, isBusy, isErrored } from "./deviceBinding";
import type { PooledDevice } from "./devicePool";
import type { Platform } from "../models";

/**
 * Read side of the device-entry table: what a consumer needs to look devices up
 * without being able to add, remove, or renumber an entry.
 */
export interface DeviceTableReader {
  get(deviceId: string): PooledDevice | undefined;
  has(deviceId: string): boolean;
  readonly size: number;
  /** Every pooled entry, in insertion order. */
  all(): PooledDevice[];
  /** The entry currently held by `sessionId`, if any. */
  heldBy(sessionId: string): PooledDevice | null;
  /** Entries held by a session and in the busy state. */
  assigned(): PooledDevice[];
  /** Entries in the error state. */
  errored(): PooledDevice[];
  byPlatform(platform: Platform): PooledDevice[];
}

/** Narrow table surface: lookups plus entry add/remove and incarnation numbering. */
export interface DeviceTable extends DeviceTableReader {
  set(deviceId: string, device: PooledDevice): void;
  delete(deviceId: string): boolean;
  ids(): string[];
  /** Assign the next monotonic incarnation id for a newly pooled connection. */
  nextIncarnation(): number;
}

/** Owns the pooled-device entries and the incarnation counter; no locking, no side effects. */
export class InMemoryDeviceTable implements DeviceTable {
  private readonly entries = new Map<string, PooledDevice>();
  private incarnationCounter = 0;

  get(deviceId: string): PooledDevice | undefined {
    return this.entries.get(deviceId);
  }

  has(deviceId: string): boolean {
    return this.entries.has(deviceId);
  }

  get size(): number {
    return this.entries.size;
  }

  set(deviceId: string, device: PooledDevice): void {
    this.entries.set(deviceId, device);
  }

  delete(deviceId: string): boolean {
    return this.entries.delete(deviceId);
  }

  ids(): string[] {
    return Array.from(this.entries.keys());
  }

  all(): PooledDevice[] {
    return Array.from(this.entries.values());
  }

  heldBy(sessionId: string): PooledDevice | null {
    return this.all().find((device) => holderOf(device) === sessionId) ?? null;
  }

  assigned(): PooledDevice[] {
    return this.all().filter((device) => isBusy(device) && holderOf(device) !== null);
  }

  errored(): PooledDevice[] {
    return this.all().filter((device) => isErrored(device));
  }

  byPlatform(platform: Platform): PooledDevice[] {
    return this.all().filter((device) => device.platform === platform);
  }

  nextIncarnation(): number {
    return ++this.incarnationCounter;
  }

  /** The live backing map, for ports that take a `ReadonlyMap` and for pool test internals. */
  backingMap(): Map<string, PooledDevice> {
    return this.entries;
  }
}
