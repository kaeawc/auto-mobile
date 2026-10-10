/**
 * Device ports whose state lives in a JSON file, so a device created or deleted by a process that
 * is then SIGKILLed is still seen (or still gone) by the next process. Used by the journal restart
 * test (#11179) and its child fixture.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  deviceStableId,
  type ManagedSlotDeletionResult,
  type ManagedSlotDeletionTarget,
  type ManagedSlotDeviceDeleter,
  type ManagedSlotDeviceProvisioner,
  type ManagedSlotInventory,
  type ManagedSlotInventorySnapshot,
  type ManagedSlotProvisionRequest,
  type ManagedSlotProvisionedDevice,
} from "../../../../src/daemon/managedSlots/reconciler";
import type { SlotPlatform } from "../../../../src/daemon/managedSlots/slotRegistry";
import type { DeviceInfo } from "../../../../src/models";

export const CRASH_POINTS = ["none", "after-delete", "after-create"] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

export function parseCrashPoint(value: string | undefined): CrashPoint {
  const point = CRASH_POINTS.find((candidate) => candidate === value);
  if (!point) {
    throw new Error(`unknown crash point ${value}`);
  }
  return point;
}

interface DeviceState {
  devices: DeviceInfo[];
  /** Every destructive or creating call ever made, across processes. */
  log: string[];
}

export class FileDeviceState {
  constructor(private readonly path: string) {}

  read(): DeviceState {
    if (!existsSync(this.path)) {
      return { devices: [], log: [] };
    }
    const parsed: DeviceState = JSON.parse(readFileSync(this.path, "utf8"));
    return parsed;
  }

  write(state: DeviceState): void {
    writeFileSync(this.path, JSON.stringify(state));
  }
}

/** Write the marker the parent waits on, then never return: the parent SIGKILLs this process. */
function crashHere(markerPath: string): Promise<never> {
  writeFileSync(markerPath, "reached");
  return new Promise<never>(() => {});
}

export class FileInventory implements ManagedSlotInventory {
  constructor(private readonly state: FileDeviceState) {}
  async list(platform: SlotPlatform): Promise<ManagedSlotInventorySnapshot> {
    return {
      complete: true,
      devices: this.state.read().devices.filter((device) => device.platform === platform),
    };
  }
}

export class FileDeleter implements ManagedSlotDeviceDeleter {
  constructor(
    private readonly state: FileDeviceState,
    private readonly crash: CrashPoint = "none",
    private readonly markerPath = "",
  ) {}
  async deleteAndVerifyAbsence(
    target: ManagedSlotDeletionTarget,
  ): Promise<ManagedSlotDeletionResult> {
    const current = this.state.read();
    this.state.write({
      devices: current.devices.filter((device) => deviceStableId(device) !== target.stableId),
      log: [...current.log, `delete ${target.stableId}`],
    });
    if (this.crash === "after-delete") {
      return crashHere(this.markerPath);
    }
    return { kind: "absent", evidence: { verified: true } };
  }
}

export class FileProvisioner implements ManagedSlotDeviceProvisioner {
  private nextSession = 1;
  constructor(
    private readonly state: FileDeviceState,
    private readonly crash: CrashPoint = "none",
    private readonly markerPath = "",
  ) {}

  async provision(request: ManagedSlotProvisionRequest): Promise<ManagedSlotProvisionedDevice> {
    const current = this.state.read();
    let device = current.devices.find((entry) =>
      request.deviceId ? entry.deviceId === request.deviceId : entry.name === request.name,
    );
    if (request.mode === "create") {
      device = {
        name: request.name,
        platform: request.platform,
        isRunning: true,
        runtime: request.spec.runtime,
        deviceType: request.spec.deviceType,
        deviceId: `UDID-${current.log.length + 1}`,
      };
      this.state.write({
        devices: [...current.devices, device],
        log: [...current.log, `create ${device.deviceId}`],
      });
      if (this.crash === "after-create") {
        return crashHere(this.markerPath);
      }
    }
    if (!device) {
      throw new Error(`no device ${request.name}`);
    }
    return {
      device: {
        stableId: deviceStableId(device)!,
        transportId: device.deviceId!,
        name: device.name,
      },
      created: request.mode === "create",
      sessionUuid: `${process.pid}-session-${this.nextSession++}`,
      readiness: { mode: "automation", status: "automation_ready" },
    };
  }

  async releaseSession(): Promise<void> {}
}
