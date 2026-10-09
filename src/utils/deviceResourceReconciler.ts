import type { BootedDevice } from "../models/DeviceInfo";
import type { AppleDeviceResource } from "../models/AppleDeviceResource";
import { ActionableError } from "../models/ActionableError";
import type { DeviceResourceConfiguration } from "../models/DeviceResourceConfiguration";
import type {
  DeviceResourceReconciliation,
  SimulatorResourceIdentity,
  SimulatorWorkloadProfile,
} from "../models/DeviceResourceReconciliation";
import type { DeviceResourceController } from "./deviceResourceController";
import type { DeviceResourceObserver } from "./deviceResourceObserver";
import type { DeviceResourceApplicationStore } from "./deviceResourceApplicationStore";
import {
  computeDeviceResourceDrift,
  deviceResourceProfileFingerprint,
  nextOwnedOverrides,
} from "./deviceResourceDrift";
import { resolveIosDeviceKind } from "./ios-cmdline-tools/IosDeviceKind";
import type { Timer } from "./SystemTimer";

export interface DeviceResourceReconcileRequest {
  device: BootedDevice;
  profile: SimulatorWorkloadProfile;
  /** Apply the requested delta through the service-transition client. Default: report only. */
  repair?: boolean;
  /** With `repair`, also re-enable owned extra overrides not in this profile. */
  releaseOwnedExtras?: boolean;
  deadlineMs: number;
  signal?: AbortSignal;
}

/** Compares a requested workload profile with observed simulator state; repairs only on request. */
export interface DeviceResourceReconciler {
  reconcile(request: DeviceResourceReconcileRequest): Promise<DeviceResourceReconciliation>;
}

/** Resolves the booted simulator incarnation; null when the target is not a booted iOS Simulator. */
export interface SimulatorResourceIdentityReader {
  readIdentity(request: {
    device: BootedDevice;
    deadlineMs: number;
    signal?: AbortSignal;
  }): Promise<SimulatorResourceIdentity | null>;
}

function isSimulator(device: BootedDevice): boolean {
  return device.platform === "ios" && resolveIosDeviceKind(device) === "simulator";
}

export class DefaultDeviceResourceReconciler implements DeviceResourceReconciler {
  constructor(
    private readonly dependencies: {
      controller: DeviceResourceController;
      observer: DeviceResourceObserver;
      identity: SimulatorResourceIdentityReader;
      store: DeviceResourceApplicationStore;
      timer: Pick<Timer, "now">;
    },
  ) {}

  async reconcile(request: DeviceResourceReconcileRequest): Promise<DeviceResourceReconciliation> {
    request.signal?.throwIfAborted();
    if (!isSimulator(request.device)) {
      throw new ActionableError(
        "Resource reconciliation requires a booted iOS Simulator; physical devices and Android targets are untouched.",
      );
    }
    const identity = await this.requireIdentity(request);
    const { controller, store } = this.dependencies;
    const requested = request.profile.resources;
    const profileFingerprint = deviceResourceProfileFingerprint(request.profile);
    const prior = (await store.get(identity))?.resources ?? {};
    const before = await this.observe(request);
    const drift = computeDeviceResourceDrift(requested, before.resources, prior);
    const report = {
      identity,
      requested,
      profileFingerprint,
      drift,
      verification: "current_boot" as const,
    };
    if (!request.repair) {
      return { ...report, success: drift.length === 0, remainingDrift: drift, observed: before };
    }

    const delta: DeviceResourceConfiguration = {};
    for (const entry of drift) {
      if (entry.kind === "missingRequested" || entry.kind === "commandFailure") {
        delta[entry.resource] = entry.expected;
      } else if (entry.kind === "ownedExtra" && request.releaseOwnedExtras) {
        delta[entry.resource] = "enabled";
      }
    }
    if (!Object.keys(delta).length) {
      // Idempotent: nothing to apply, and no state to re-prove beyond the read just taken.
      return { ...report, success: drift.length === 0, remainingDrift: drift, observed: before };
    }
    const applied = await controller.setResources({
      device: request.device,
      resources: delta,
      deadlineMs: request.deadlineMs,
      signal: request.signal,
    });
    // Never infer success from acknowledgement: re-read every resource independently.
    const after = await this.observe(request);
    const owned = nextOwnedOverrides(prior, delta, applied.changed, after.resources);
    await this.persist(identity, owned, profileFingerprint);
    const remainingDrift = computeDeviceResourceDrift(requested, after.resources, owned);
    return {
      ...report,
      success: remainingDrift.length === 0,
      remainingDrift,
      applied,
      observed: after,
    };
  }

  private async requireIdentity(
    request: DeviceResourceReconcileRequest,
  ): Promise<SimulatorResourceIdentity> {
    const identity = await this.dependencies.identity.readIdentity(request);
    if (!identity) {
      throw new ActionableError(
        `Simulator ${request.device.deviceId} is not booted or its runtime and device type cannot be identified; boot it and retry.`,
      );
    }
    return identity;
  }

  private async observe(request: DeviceResourceReconcileRequest): Promise<AppleDeviceResource> {
    const snapshot = await this.dependencies.observer.observeResources(request);
    request.signal?.throwIfAborted();
    if (snapshot.platform !== "ios") {
      throw new ActionableError("Resource observation returned a non-iOS snapshot.");
    }
    return snapshot;
  }

  private async persist(
    identity: SimulatorResourceIdentity,
    owned: DeviceResourceConfiguration,
    profileFingerprint: string,
  ): Promise<void> {
    const { store, timer } = this.dependencies;
    if (!Object.keys(owned).length) {
      await store.delete(identity);
      return;
    }
    await store.put({ identity, resources: owned, profileFingerprint, updatedAtMs: timer.now() });
  }
}
