import {
  disabledResourcesOf,
  findUnsafeResourceCombinations,
  iosDeviceResourceHazards,
  type IosDeviceResourceHazard,
} from "./iosDeviceResourceHazards";
import { toActionableError } from "../models/ActionableError";
import { UnsafeDeviceResourceCombinationError } from "../models/UnsafeDeviceResourceCombinationError";
import { IosDeviceResourceReader, type ServiceDefinition } from "./iosDeviceResourceReader";
import { readdir } from "node:fs/promises";
import type { BootedDevice } from "../models/DeviceInfo";
import type { DeviceResourceStatus } from "../models/DeviceResource";
import type {
  ConfigurableDeviceResource,
  DeviceResourceConfiguration,
  DeviceResourceConfigurationResult,
  RequestedDeviceResourceState,
} from "../models/DeviceResourceConfiguration";
import { SimCtlClient, type SimCtl } from "./ios-cmdline-tools/SimCtlClient";
import { PlistClient, type PlistReader } from "./ios-cmdline-tools/PlistClient";
import { resolveIosDeviceKind } from "./ios-cmdline-tools/IosDeviceKind";
import { defaultTimer, type Timer } from "./SystemTimer";
import { errorMessage } from "./describeUnknownError";
import { logger } from "./logger";
import { iosDeviceResourceCatalog } from "./iosDeviceResourceCatalog";
import { AndroidDeviceResourceController } from "./androidDeviceResourceController";
import type { AndroidResourceRestoration } from "../models/AndroidResourceRestoration";
import type { DeviceResourceApplicationStore } from "./deviceResourceApplicationStore";
import { deviceResourceProfileFingerprint, nextOwnedOverrides } from "./deviceResourceDrift";

export interface DeviceResourceRequest {
  device: BootedDevice;
  resources: DeviceResourceConfiguration;
  deadlineMs: number;
  signal?: AbortSignal;
  restore?: AndroidResourceRestoration;
}

export interface DeviceResourceController {
  setResources(request: DeviceResourceRequest): Promise<DeviceResourceConfigurationResult>;
}

interface ResourceRun {
  request: DeviceResourceRequest;
  result: DeviceResourceConfigurationResult;
  inventory?: Promise<Map<string, string>>;
}

export interface DeviceResourceControllerExtras {
  /** Records AutoMobile-applied simulator overrides; omitted means no ownership metadata. */
  applications?: DeviceResourceApplicationStore | null;
  /** Unsafe iOS resource combinations to refuse; defaults to the shipped table. */
  hazards?: readonly IosDeviceResourceHazard[];
  /** Handles Android requests; defaults to `AndroidDeviceResourceController`. */
  android?: DeviceResourceController;
}

export class DefaultDeviceResourceController implements DeviceResourceController {
  constructor(
    simctl: Pick<SimCtl, "executeCommandArgs"> = new SimCtlClient(null),
    plist: Pick<PlistReader, "readJsonFile"> = new PlistClient(),
    private readonly timer: Pick<Timer, "now" | "sleep"> = defaultTimer,
    readDirectory: (path: string) => Promise<string[]> = readdir,
    extras: DeviceResourceControllerExtras = {},
  ) {
    this.android = extras.android ?? new AndroidDeviceResourceController();
    this.applications = extras.applications ?? null;
    this.hazards = extras.hazards ?? iosDeviceResourceHazards;
    this.reader = new IosDeviceResourceReader({ simctl, plist, timer, readDirectory });
  }
  private readonly android: DeviceResourceController;
  private readonly reader: IosDeviceResourceReader;
  private readonly applications: DeviceResourceApplicationStore | null;
  private readonly hazards: readonly IosDeviceResourceHazard[];

  async setResources(request: DeviceResourceRequest): Promise<DeviceResourceConfigurationResult> {
    if (request.device.platform === "android") {
      return this.android.setResources(request);
    }
    if (request.restore) {
      throw new Error("Android resource restoration requires an Android emulator");
    }
    const result: DeviceResourceConfigurationResult = {
      success: true,
      requested: request.resources,
      resources: {},
      services: {},
      changed: [],
      verification: "current_boot",
    };
    const run: ResourceRun = { request, result };
    await this.assertSafeTransitions(run);
    for (const resource of Object.keys(request.resources) as ConfigurableDeviceResource[]) {
      const desired = request.resources[resource];
      if (desired === undefined) {
        continue;
      }
      let observed: DeviceResourceStatus;
      try {
        this.reader.remaining(request);
        observed = await this.setResource(run, resource, desired);
        request.signal?.throwIfAborted();
      } catch (error) {
        request.signal?.throwIfAborted();
        observed = this.failure(error);
      }
      result.resources[resource] = observed;
      if (observed.state !== desired) {
        result.success = false;
      }
    }
    await this.recordApplied(run);
    return result;
  }

  /**
   * Refuses a hazardous change before any mutation. Only a loaded service is booted out, so a hazard
   * resource whose services are all unloaded (already disabled, or never started) is safe to set.
   */
  private async assertSafeTransitions(run: ResourceRun): Promise<void> {
    if (resolveIosDeviceKind(run.request.device) !== "simulator") {
      return;
    }
    const candidates = findUnsafeResourceCombinations(
      disabledResourcesOf(run.request.resources),
      this.hazards,
      "post_boot",
    );
    const unsafe: IosDeviceResourceHazard[] = [];
    const bootout = new Map<ConfigurableDeviceResource, boolean>();
    for (const hazard of candidates) {
      for (const resource of hazard.resources) {
        if (!bootout.has(resource)) {
          bootout.set(resource, await this.wouldBootOut(run, resource));
        }
      }
      if (hazard.resources.some((resource) => bootout.get(resource))) {
        unsafe.push(hazard);
      }
    }
    if (unsafe.length) {
      throw new UnsafeDeviceResourceCombinationError(unsafe);
    }
  }

  private async wouldBootOut(
    run: ResourceRun,
    resource: ConfigurableDeviceResource,
  ): Promise<boolean> {
    const catalog: Partial<Record<ConfigurableDeviceResource, readonly string[]>> =
      iosDeviceResourceCatalog;
    try {
      run.inventory ??= this.reader.readRuntimeInventory(run.request);
      const paths = await run.inventory;
      // Absent definitions cannot be transitioned by this controller.
      const labels = (catalog[resource] ?? []).filter((label) => paths.has(label));
      for (const label of labels) {
        if ((await this.reader.readService(run.request, label)).loaded) {
          return true;
        }
      }
      return false;
    } catch (error) {
      run.request.signal?.throwIfAborted();
      // An unproven state is a retryable read failure, not a verdict that the combination is unsafe.
      throw toActionableError(error, `Cannot verify the state of resource ${resource}`);
    }
  }

  /** Best effort: ownership metadata never changes the verified mutation result. */
  private async recordApplied({ request, result }: ResourceRun): Promise<void> {
    if (!this.applications || !result.changed.length) {
      return;
    }
    try {
      const identity = await this.reader.readIdentity(request);
      if (!identity) {
        return;
      }
      const prior = (await this.applications.get(identity))?.resources ?? {};
      const owned = nextOwnedOverrides(prior, request.resources, result.changed, result.resources);
      if (!Object.keys(owned).length) {
        await this.applications.delete(identity);
        return;
      }
      await this.applications.put({
        identity,
        resources: owned,
        profileFingerprint: deviceResourceProfileFingerprint({ resources: request.resources }),
        updatedAtMs: this.timer.now(),
      });
    } catch (error) {
      request.signal?.throwIfAborted();
      logger.warn(`Recording applied simulator overrides failed: ${errorMessage(error)}`, error);
    }
  }

  private async setResource(
    run: ResourceRun,
    resource: ConfigurableDeviceResource,
    desired: RequestedDeviceResourceState,
  ): Promise<DeviceResourceStatus> {
    const catalog: Partial<Record<ConfigurableDeviceResource, readonly string[]>> =
      iosDeviceResourceCatalog;
    const labels = catalog[resource];
    if (!labels) {
      return {
        state: "unsupported",
        reason:
          "This resource has no approved control implementation; use a narrower resource where available.",
      };
    }
    if (resolveIosDeviceKind({ deviceId: run.request.device.deviceId }) !== "simulator") {
      return { state: "unsupported", reason: "Resource control requires an iOS Simulator." };
    }
    run.inventory ??= this.reader.readRuntimeInventory(run.request);
    const paths = await run.inventory;
    const evidence: Record<string, DeviceResourceStatus> = {};
    run.result.services![resource] = evidence;
    const definitions = await this.reader.resolveDefinitions(run.request, labels, paths, evidence);
    if (!definitions.length) {
      return {
        state: "unsupported",
        reason:
          "No compatible installed service definitions for this resource on the booted runtime.",
      };
    }
    for (const definition of definitions) {
      try {
        evidence[definition.label] = await this.setService(run, resource, definition, desired);
      } catch (error) {
        run.request.signal?.throwIfAborted();
        evidence[definition.label] = this.failure(error);
      }
    }
    const matches = definitions.every(({ label }) => evidence[label]?.state === desired);
    const absent = labels.filter((label) => !paths.has(label));
    if (!matches) {
      return {
        state: "unknown",
        reason:
          "Not all installed services reached the requested state; inspect service evidence and retry to reconcile.",
      };
    }
    return absent.length
      ? {
          state: desired,
          reason: `Verified all ${definitions.length} installed services; ${absent.length} catalog services are absent on this runtime.`,
        }
      : { state: desired };
  }

  private async setService(
    run: ResourceRun,
    resource: ConfigurableDeviceResource,
    definition: ServiceDefinition,
    desired: RequestedDeviceResourceState,
  ): Promise<DeviceResourceStatus> {
    const before = await this.reader.readService(run.request, definition.label);
    if (before.state === desired) {
      return { state: desired };
    }
    await this.reader.command(run.request, [
      "launchctl",
      desired === "disabled" ? "disable" : "enable",
      `system/${definition.label}`,
    ]);
    if (!run.result.changed.includes(resource)) {
      run.result.changed.push(resource);
    }
    if (desired === "disabled" && before.loaded) {
      await this.reader.command(run.request, [
        "launchctl",
        "bootout",
        `system/${definition.label}`,
      ]);
    } else if (desired === "enabled" && !before.loaded) {
      await this.reader.command(run.request, ["launchctl", "bootstrap", "system", definition.path]);
    }
    return this.verifyTransition(run.request, definition.label, desired);
  }

  private async verifyTransition(
    request: DeviceResourceRequest,
    label: string,
    desired: RequestedDeviceResourceState,
  ): Promise<DeviceResourceStatus> {
    // bootout can acknowledge before launchd finishes unregistering a job.
    const verification = {
      ...request,
      deadlineMs: Math.min(request.deadlineMs, this.timer.now() + 10_000),
    };
    do {
      if ((await this.reader.readService(verification, label)).state === desired) {
        return { state: desired };
      }
      await this.timer.sleep(Math.min(100, this.reader.remaining(verification)));
    } while (this.timer.now() < verification.deadlineMs);
    return {
      state: "unknown",
      reason:
        "Service registration and override did not reach the requested state within the verification budget.",
    };
  }

  private failure(error: unknown): DeviceResourceStatus {
    logger.warn(`Device resource configuration failed: ${errorMessage(error)}`, error);
    return { state: "unknown", reason: errorMessage(error) };
  }
}
