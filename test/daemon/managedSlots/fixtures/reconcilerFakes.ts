import {
  deviceStableId,
  type ManagedSlotBootCapacity,
  type ManagedSlotCapacityCheck,
  type ManagedSlotDeletionResult,
  type ManagedSlotDeletionTarget,
  type ManagedSlotDeviceClaim,
  type ManagedSlotDeviceClaims,
  type ManagedSlotDeviceDeleter,
  type ManagedSlotDeviceProvisioner,
  type ManagedSlotInventory,
  type ManagedSlotInventorySnapshot,
  type ManagedSlotProvisionRequest,
  type ManagedSlotProvisionedDevice,
  type ManagedSlotRequestedSpec,
  type ManagedSpecMatch,
  type ManagedSpecMatcher,
} from "../../../../src/daemon/managedSlots/reconciler";
import type { SlotPlatform } from "../../../../src/daemon/managedSlots/slotRegistry";
import { ProvisionDeviceError } from "../../../../src/devices/exactDeviceProvisioning";
import type { DeviceInfo } from "../../../../src/models";

// Port fakes shared by the reconciler and journal-redrive suites (#11175, #11179).
export class FakeInventory implements ManagedSlotInventory {
  complete = true;
  devices: DeviceInfo[] = [];
  async list(platform: SlotPlatform): Promise<ManagedSlotInventorySnapshot> {
    return {
      complete: this.complete,
      devices: this.devices.filter((device) => device.platform === platform),
    };
  }
  has(stableId: string): boolean {
    return this.devices.some((device) => deviceStableId(device) === stableId);
  }
  remove(stableId: string): void {
    this.devices = this.devices.filter((device) => deviceStableId(device) !== stableId);
  }
}

/** iOS-style matching on listed runtime/device type; overrides force a verdict per stable id. */
export class FakeMatcher implements ManagedSpecMatcher {
  readonly overrides = new Map<string, ManagedSpecMatch>();
  async matches(device: DeviceInfo, spec: ManagedSlotRequestedSpec): Promise<ManagedSpecMatch> {
    const override = this.overrides.get(deviceStableId(device) ?? "");
    if (override) {
      return override;
    }
    return device.runtime === spec.runtime &&
      (spec.deviceType === undefined || device.deviceType === spec.deviceType)
      ? "match"
      : "mismatch";
  }
}

export class FakeProvisioner implements ManagedSlotDeviceProvisioner {
  readonly calls: ManagedSlotProvisionRequest[] = [];
  readonly released: string[] = [];
  failWith: ((request: ManagedSlotProvisionRequest) => unknown) | undefined;
  /** Runs before a `create` makes the device (crash injection). */
  beforeCreate: ((request: ManagedSlotProvisionRequest) => Promise<void>) | undefined;
  /** Runs after the device exists but before the result returns (race injection). */
  beforeReturn: ((request: ManagedSlotProvisionRequest) => Promise<void>) | undefined;
  readinessStatus = "automation_ready";
  private nextUdid = 1;
  private nextSession = 1;

  constructor(private readonly inventory: FakeInventory) {}

  async provision(request: ManagedSlotProvisionRequest): Promise<ManagedSlotProvisionedDevice> {
    this.calls.push(request);
    const failure = this.failWith?.(request);
    if (failure) {
      throw failure;
    }
    let device: DeviceInfo | undefined;
    if (request.mode === "adopt") {
      device = this.inventory.devices.find((entry) =>
        request.deviceId ? entry.deviceId === request.deviceId : entry.name === request.name,
      );
      if (!device) {
        throw new ProvisionDeviceError("identity_conflict", `no device ${request.name}`);
      }
    } else {
      await this.beforeCreate?.(request);
      device = {
        name: request.name,
        platform: request.platform,
        isRunning: true,
        runtime: request.spec.runtime,
        deviceType: request.spec.deviceType,
        ...(request.platform === "ios" ? { deviceId: `UDID-${this.nextUdid++}` } : {}),
      };
      this.inventory.devices.push(device);
    }
    device.isRunning = true;
    await this.beforeReturn?.(request);
    const stableId = deviceStableId(device)!;
    return {
      device: {
        stableId,
        transportId: device.deviceId ?? `emulator-${stableId}`,
        name: device.name,
      },
      created: request.mode === "create",
      sessionUuid: `session-${this.nextSession++}`,
      readiness: { mode: "automation", status: this.readinessStatus },
    };
  }

  async releaseSession(sessionUuid: string): Promise<void> {
    this.released.push(sessionUuid);
  }

  created(): ManagedSlotProvisionRequest[] {
    return this.calls.filter((call) => call.mode === "create");
  }
}

export class FakeDeleter implements ManagedSlotDeviceDeleter {
  readonly calls: ManagedSlotDeletionTarget[] = [];
  failWith: string | undefined;
  /** Crash injection around the destructive step. */
  beforeDelete: ((target: ManagedSlotDeletionTarget) => Promise<void>) | undefined;
  afterDelete: ((target: ManagedSlotDeletionTarget) => Promise<void>) | undefined;
  constructor(private readonly inventory: FakeInventory) {}
  async deleteAndVerifyAbsence(
    target: ManagedSlotDeletionTarget,
  ): Promise<ManagedSlotDeletionResult> {
    this.calls.push(target);
    await this.beforeDelete?.(target);
    if (this.failWith) {
      return { kind: "failed", message: this.failWith };
    }
    this.inventory.remove(target.stableId);
    await this.afterDelete?.(target);
    return { kind: "absent", evidence: { verified: true } };
  }
  /** Stable ids of every deletion attempt, in order. */
  stableIds(): string[] {
    return this.calls.map((call) => call.stableId);
  }
}

export class FakeClaims implements ManagedSlotDeviceClaims {
  readonly claims = new Map<string, ManagedSlotDeviceClaim>();
  /** Sessions the daemon's pool holds per device stable id. */
  readonly sessions = new Map<string, string[]>();
  beforeDescribe: (() => Promise<void>) | undefined;
  async describe(device: DeviceInfo): Promise<ManagedSlotDeviceClaim> {
    await this.beforeDescribe?.();
    return this.claims.get(deviceStableId(device) ?? "") ?? { kind: "free" };
  }
  sessionsOn(device: DeviceInfo): string[] {
    return [...(this.sessions.get(deviceStableId(device) ?? "") ?? [])];
  }
}

export class FakeCapacity implements ManagedSlotBootCapacity {
  result: ManagedSlotCapacityCheck = { kind: "available" };
  checks = 0;
  async check(): Promise<ManagedSlotCapacityCheck> {
    this.checks += 1;
    return this.result;
  }
}
