import type { FleetHostSource } from "../../src/features/iosSimFleet/FleetHostSource";
import type { HostSnapshot, SimulatorInventoryEntry } from "../../src/features/iosSimFleet/types";

/** Scripted fleet host source; counts reads and can hold a read open to test single-flight. */
export class FakeFleetHostSource implements FleetHostSource {
  inventory: SimulatorInventoryEntry[] = [];
  snapshot: HostSnapshot | Error | undefined;
  inventoryError: Error | undefined;
  snapshotReads = 0;
  inventoryReads = 0;
  gate: Promise<void> | undefined;

  async readHostSnapshot(): Promise<HostSnapshot> {
    this.snapshotReads += 1;
    await this.gate;
    if (this.snapshot === undefined || this.snapshot instanceof Error) {
      throw this.snapshot ?? new Error("no snapshot scripted");
    }
    return this.snapshot;
  }

  async readInventory(): Promise<SimulatorInventoryEntry[]> {
    this.inventoryReads += 1;
    await this.gate;
    if (this.inventoryError) {
      throw this.inventoryError;
    }
    return this.inventory;
  }
}
