import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { z } from "zod/v4";
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
import { isIosSimulatorUdid } from "./ios-cmdline-tools/iosDeviceType";
import { defaultTimer, type Timer } from "./SystemTimer";
import { errorMessage } from "./describeUnknownError";
import { logger } from "./logger";
import { iosDeviceResourceCatalog, iosDeviceResourcePlistNames } from "./iosDeviceResourceCatalog";
import { AndroidDeviceResourceController } from "./androidDeviceResourceController";
import type { AndroidResourceRestoration } from "../models/AndroidResourceRestoration";

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

interface ServiceDefinition {
  label: string;
  path: string;
}
interface ResourceRun {
  request: DeviceResourceRequest;
  result: DeviceResourceConfigurationResult;
  inventory?: Promise<Map<string, string>>;
}

const deviceInventorySchema = z.object({
  devices: z.record(
    z.string(),
    z.array(z.object({ udid: z.string(), state: z.string(), isAvailable: z.boolean().optional() })),
  ),
});
const runtimeInventorySchema = z.object({
  runtimes: z.array(
    z.object({ identifier: z.string(), runtimeRoot: z.string(), isAvailable: z.boolean() }),
  ),
});

/** launchctl's diagnostic format is neither JSON nor plist. Reject ambiguous evidence. */
function disabledOverrides(output: string): Map<string, boolean> {
  const text = output.trim();
  if (text === "disabled services = (no disabled services)") {
    return new Map();
  }
  const body = /^disabled services\s*=\s*\{([\s\S]*)\}$/.exec(text)?.[1];
  if (body === undefined) {
    throw new Error("Cannot verify launchd disabled-service output");
  }
  const overrides = new Map<string, boolean>();
  for (const line of body
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const match = /^"([^"\r\n]+)"\s*=>\s*(true|false|disabled|enabled)\s*;?$/.exec(line);
    if (!match || overrides.has(match[1]!)) {
      throw new Error("Cannot verify launchd service override");
    }
    overrides.set(match[1]!, match[2] === "true" || match[2] === "disabled");
  }
  return overrides;
}

export class DefaultDeviceResourceController implements DeviceResourceController {
  constructor(
    private readonly simctl: Pick<SimCtl, "executeCommandArgs"> = new SimCtlClient(null),
    private readonly plist: Pick<PlistReader, "readJsonFile"> = new PlistClient(),
    private readonly timer: Pick<Timer, "now" | "sleep"> = defaultTimer,
    private readonly readDirectory: (path: string) => Promise<string[]> = readdir,
    private readonly android: DeviceResourceController = new AndroidDeviceResourceController(),
  ) {}

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
    for (const resource of Object.keys(request.resources) as ConfigurableDeviceResource[]) {
      const desired = request.resources[resource];
      if (desired === undefined) {
        continue;
      }
      let observed: DeviceResourceStatus;
      try {
        this.remaining(request);
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
    return result;
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
    if (!isIosSimulatorUdid(run.request.device.deviceId)) {
      return { state: "unsupported", reason: "Resource control requires an iOS Simulator." };
    }
    run.inventory ??= this.readRuntimeInventory(run.request);
    const paths = await run.inventory;
    const evidence: Record<string, DeviceResourceStatus> = {};
    run.result.services![resource] = evidence;
    const definitions = await this.resolveDefinitions(run.request, labels, paths, evidence);
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

  private async resolveDefinitions(
    request: DeviceResourceRequest,
    labels: readonly string[],
    paths: Map<string, string>,
    evidence: Record<string, DeviceResourceStatus>,
  ): Promise<ServiceDefinition[]> {
    const definitions: ServiceDefinition[] = [];
    let incompatible = false;
    for (const label of labels) {
      const path = paths.get(label);
      if (!path) {
        const loaded = await this.serviceLoaded(request, label);
        evidence[label] = {
          state: "unsupported",
          reason: loaded
            ? "A registered service has no approved runtime definition; no group changes applied."
            : "Service and approved definition are absent on this runtime.",
        };
        incompatible ||= loaded;
        continue;
      }
      const definition = await this.plist.readJsonFile(path, {
        timeoutMs: this.remaining(request),
        signal: request.signal,
      });
      const valid = z
        .object({ Label: z.literal(label), Disabled: z.literal(false).optional() })
        .safeParse(definition).success;
      if (!valid) {
        evidence[label] = {
          state: "unsupported",
          reason:
            "Runtime service identity or default/conditional enablement is incompatible; no group changes applied.",
        };
        incompatible = true;
      } else {
        definitions.push({ label, path });
        evidence[label] = { state: "unknown", reason: "Service has not been verified yet." };
      }
    }
    // Preflight the whole group before writing; never force-enable a runtime-gated job.
    return incompatible ? [] : definitions;
  }

  private async setService(
    run: ResourceRun,
    resource: ConfigurableDeviceResource,
    definition: ServiceDefinition,
    desired: RequestedDeviceResourceState,
  ): Promise<DeviceResourceStatus> {
    const before = await this.readService(run.request, definition.label);
    if (before.state === desired) {
      return { state: desired };
    }
    await this.command(run.request, [
      "launchctl",
      desired === "disabled" ? "disable" : "enable",
      `system/${definition.label}`,
    ]);
    if (!run.result.changed.includes(resource)) {
      run.result.changed.push(resource);
    }
    if (desired === "disabled" && before.loaded) {
      await this.command(run.request, ["launchctl", "bootout", `system/${definition.label}`]);
    } else if (desired === "enabled" && !before.loaded) {
      await this.command(run.request, ["launchctl", "bootstrap", "system", definition.path]);
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
      if ((await this.readService(verification, label)).state === desired) {
        return { state: desired };
      }
      await this.timer.sleep(Math.min(100, this.remaining(verification)));
    } while (this.timer.now() < verification.deadlineMs);
    return {
      state: "unknown",
      reason:
        "Service registration and override did not reach the requested state within the verification budget.",
    };
  }

  private remaining(request: DeviceResourceRequest): number {
    request.signal?.throwIfAborted();
    const remaining = Math.floor(request.deadlineMs - this.timer.now());
    if (remaining <= 0) {
      throw new Error("Device resource configuration timed out");
    }
    return remaining;
  }

  private async execute(request: DeviceResourceRequest, args: string[]): Promise<string> {
    const result = await this.simctl.executeCommandArgs(
      args,
      this.remaining(request),
      request.signal,
    );
    if (result.error) {
      throw new Error(result.error);
    }
    return result.stdout;
  }

  private command(request: DeviceResourceRequest, args: string[]): Promise<string> {
    return this.execute(request, ["spawn", request.device.deviceId, ...args]);
  }

  private async readRuntimeInventory(request: DeviceResourceRequest): Promise<Map<string, string>> {
    const inventory = deviceInventorySchema.parse(
      JSON.parse(await this.execute(request, ["list", "devices", "--json"])),
    );
    const runtimeId = Object.entries(inventory.devices).find(
      ([id, entries]) =>
        id.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-") &&
        entries.some(
          (device) =>
            device.udid === request.device.deviceId &&
            device.state === "Booted" &&
            device.isAvailable !== false,
        ),
    )?.[0];
    if (!runtimeId) {
      return new Map();
    }
    const runtimes = runtimeInventorySchema.parse(
      JSON.parse(await this.execute(request, ["list", "runtimes", "--json"])),
    );
    const runtime = runtimes.runtimes.find(
      (entry) => entry.identifier === runtimeId && entry.isAvailable,
    );
    if (!runtime) {
      return new Map();
    }
    return this.readServicePaths(request, runtime.runtimeRoot);
  }

  private async readServicePaths(
    request: DeviceResourceRequest,
    runtimeRoot: string,
  ): Promise<Map<string, string>> {
    const paths = new Map<string, string>();
    const allowed = new Set<string>(Object.values(iosDeviceResourceCatalog).flat());
    for (const directory of ["LaunchDaemons", "LaunchAgents", "LaunchAngels"]) {
      this.remaining(request);
      const root = join(runtimeRoot, "System/Library", directory);
      let files: string[];
      try {
        files = await this.readDirectory(root);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          logger.debug(`Optional launchd directory absent: ${root}`);
          continue;
        }
        throw error;
      }
      for (const label of allowed) {
        const candidates = new Set([`${label}.plist`, iosDeviceResourcePlistNames[label]]);
        const matches = files.filter((file) => candidates.has(file));
        if (!matches.length) {
          continue;
        }
        if (paths.has(label) || matches.length > 1) {
          throw new Error(`Ambiguous installed service definition: ${label}`);
        }
        paths.set(label, join(root, matches[0]!));
      }
    }
    return paths;
  }

  private async readService(
    request: DeviceResourceRequest,
    label: string,
  ): Promise<{ loaded: boolean; state: RequestedDeviceResourceState | "unknown" }> {
    const disabled =
      disabledOverrides(await this.command(request, ["launchctl", "print-disabled", "system"])).get(
        label,
      ) ?? false;
    const loaded = await this.serviceLoaded(request, label);
    const state = disabled ? (loaded ? "unknown" : "disabled") : loaded ? "enabled" : "unknown";
    return { loaded, state };
  }

  private async serviceLoaded(request: DeviceResourceRequest, label: string): Promise<boolean> {
    try {
      await this.command(request, ["launchctl", "print", `system/${label}`]);
      return true;
    } catch (error) {
      this.remaining(request);
      if (errorMessage(error).includes(`Could not find service "${label}" in domain for system`)) {
        logger.debug(`Service is not registered: ${label}`);
        return false;
      }
      throw error;
    }
  }

  private failure(error: unknown): DeviceResourceStatus {
    logger.warn(`Device resource configuration failed: ${errorMessage(error)}`, error);
    return { state: "unknown", reason: errorMessage(error) };
  }
}
