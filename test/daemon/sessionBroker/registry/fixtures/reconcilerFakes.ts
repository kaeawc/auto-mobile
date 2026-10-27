import type {
  BindingBootReservation,
  BindingBootReservationOptions,
} from "../../../../../src/daemon/sessionBroker/provisioning/reconcilerContracts";
import {
  deviceStableId,
  type BindingBootCapacity,
  type BindingCapacityCheck,
  type BindingDeletionResult,
  type BindingDeletionTarget,
  type BindingDeviceClaim,
  type BindingDeviceClaims,
  type BindingDeviceDeleter,
  type BindingDeviceProvisioner,
  type BindingInventory,
  type BindingInventorySnapshot,
  type BindingProvisionRequest,
  type BindingProvisionedDevice,
  type BindingRequestedSpec,
  type ManagedSpecMatch,
  type ManagedSpecMatcher,
} from "../../../../../src/daemon/sessionBroker/provisioning/reconciler";
import type { BindingPlatform } from "../../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import {
  ProvisionDeviceError,
  type ResolvedExactDeviceSpecification,
} from "../../../../../src/devices/exactDeviceProvisioning";
import { classifyDisplayCutout } from "../../../../../src/utils/displayCutout";
import type { DeviceInfo } from "../../../../../src/models/index";

// Port fakes shared by the reconciler and journal-redrive suites (#11175, #11179).
export class FakeInventory implements BindingInventory {
  runtimeDeviceId: NonNullable<BindingInventory["runtimeDeviceId"]> = async (device) =>
    device.deviceId;
  /** Names the one-shot power probe was asked about, in call order. */
  readonly probedRunning: string[] = [];
  /** Names the probe proves running; any other name is not provably running. */
  readonly provablyRunning = new Set<string>();
  probeRunning: BindingInventory["probeRunning"] = async (device) => {
    this.probedRunning.push(device.name);
    return this.provablyRunning.has(device.name);
  };
  complete = true;
  devices: DeviceInfo[] = [];
  beforeList:
    | ((platform: BindingPlatform, options: { signal?: AbortSignal }) => Promise<void>)
    | undefined;
  async list(
    platform: BindingPlatform,
    options: { signal?: AbortSignal } = {},
  ): Promise<BindingInventorySnapshot> {
    await this.beforeList?.(platform, options);
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
  beforeMatch: (() => Promise<void>) | undefined;
  async matches(device: DeviceInfo, spec: BindingRequestedSpec): Promise<ManagedSpecMatch> {
    await this.beforeMatch?.();
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

export class FakeProvisioner implements BindingDeviceProvisioner {
  readonly calls: BindingProvisionRequest[] = [];
  readonly released: string[] = [];
  failWith: ((request: BindingProvisionRequest) => unknown) | undefined;
  /** Runs before a `create` makes the device (crash injection). */
  beforeCreate: ((request: BindingProvisionRequest) => Promise<void>) | undefined;
  /** Runs after the device exists but before the result returns (race injection). */
  beforeReturn: ((request: BindingProvisionRequest) => Promise<void>) | undefined;
  readinessStatus = "automation_ready";
  private nextUdid = 1;
  private nextSession = 1;

  constructor(private readonly inventory: FakeInventory) {}

  async readExistingSpec(device: DeviceInfo): Promise<ResolvedExactDeviceSpecification | null> {
    if (!device.runtime || !device.deviceType) {
      return null;
    }
    return {
      runtime: device.runtime,
      deviceType: device.deviceType,
      displayCutout: classifyDisplayCutout(device.platform, device.deviceType),
    };
  }

  async provision(request: BindingProvisionRequest): Promise<BindingProvisionedDevice> {
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

  created(): BindingProvisionRequest[] {
    return this.calls.filter((call) => call.mode === "create");
  }
}

export class FakeDeleter implements BindingDeviceDeleter {
  readonly calls: BindingDeletionTarget[] = [];
  failWith: string | undefined;
  /** Fail as the workflow does once its process-level escalation ran and the device stayed (#14018). */
  failWithEscalationExhausted: string | undefined;
  /** Crash injection around the destructive step. */
  beforeDelete: ((target: BindingDeletionTarget) => Promise<void>) | undefined;
  afterDelete: ((target: BindingDeletionTarget) => Promise<void>) | undefined;
  constructor(private readonly inventory: FakeInventory) {}
  async deleteAndVerifyAbsence(target: BindingDeletionTarget): Promise<BindingDeletionResult> {
    this.calls.push(target);
    await this.beforeDelete?.(target);
    if (this.failWithEscalationExhausted) {
      return {
        kind: "failed",
        message: this.failWithEscalationExhausted,
        escalationExhausted: true,
      };
    }
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

export class FakeClaims implements BindingDeviceClaims {
  readonly claims = new Map<string, BindingDeviceClaim>();
  /** Sessions the daemon's pool holds per device stable id. */
  readonly sessions = new Map<string, string[]>();
  beforeDescribe: (() => Promise<void>) | undefined;
  async describe(device: DeviceInfo): Promise<BindingDeviceClaim> {
    await this.beforeDescribe?.();
    return this.claims.get(deviceStableId(device) ?? "") ?? { kind: "free" };
  }
  sessionsOn(device: DeviceInfo): string[] {
    return [...(this.sessions.get(deviceStableId(device) ?? "") ?? [])];
  }
  /** Sessions the daemon holds as live managed executions (#11275). */
  readonly liveExecutions = new Set<string>();
  isLiveExecution(sessionUuid: string): boolean {
    return this.liveExecutions.has(sessionUuid);
  }
}

export class FakeCapacity implements BindingBootCapacity {
  result: BindingCapacityCheck = { kind: "available" };
  checks = 0;
  async reserve(
    _platform: BindingPlatform,
    options: BindingBootReservationOptions,
  ): Promise<BindingBootReservation> {
    const replacingDeviceId = options.resolveReplacingDeviceId
      ? await options.resolveReplacingDeviceId({ signal: options.signal })
      : options.replacingDeviceId;
    const result = await this.check();
    if (
      result.kind === "unknown" ||
      (result.kind === "exhausted" && result.booted - (replacingDeviceId ? 1 : 0) >= result.limit)
    ) {
      return result;
    }
    return {
      kind: "available",
      reservation: {
        run: (operation) => operation(),
        release: () => {},
        markReplacedDeviceGone: () => {},
      },
    };
  }
  async check(): Promise<BindingCapacityCheck> {
    this.checks += 1;
    return this.result;
  }
}
