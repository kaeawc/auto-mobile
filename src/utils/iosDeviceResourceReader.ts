import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { z } from "zod/v4";
import type { DeviceResourceStatus } from "../models/DeviceResource";
import type { RequestedDeviceResourceState } from "../models/DeviceResourceConfiguration";
import type { DeviceResourceObservationRequest } from "./deviceResourceObserver";
import { SimCtlClient, type SimCtl } from "./ios-cmdline-tools/SimCtlClient";
import { PlistClient, type PlistReader } from "./ios-cmdline-tools/PlistClient";
import { defaultTimer, type Timer } from "./SystemTimer";
import { errorMessage } from "./describeUnknownError";
import { logger } from "./logger";
import { iosDeviceResourceCatalog, iosDeviceResourcePlistNames } from "./iosDeviceResourceCatalog";

export interface ServiceDefinition {
  label: string;
  path: string;
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

/** Shared Simulator inventory and launchd reads; command is also used by the controller. */
export class IosDeviceResourceReader {
  private readonly simctl: Pick<SimCtl, "executeCommandArgs">;
  private readonly plist: Pick<PlistReader, "readJsonFile">;
  private readonly timer: Pick<Timer, "now">;
  private readonly readDirectory: (path: string) => Promise<string[]>;
  constructor(
    options: {
      simctl?: Pick<SimCtl, "executeCommandArgs">;
      plist?: Pick<PlistReader, "readJsonFile">;
      timer?: Pick<Timer, "now">;
      readDirectory?: (path: string) => Promise<string[]>;
    } = {},
  ) {
    this.simctl = options.simctl ?? new SimCtlClient(null);
    this.plist = options.plist ?? new PlistClient();
    this.timer = options.timer ?? defaultTimer;
    this.readDirectory = options.readDirectory ?? readdir;
  }
  private readonly observationReads = new WeakMap<
    DeviceResourceObservationRequest,
    Map<string, Promise<string>>
  >();

  createObservationRequest(
    request: DeviceResourceObservationRequest,
  ): DeviceResourceObservationRequest {
    const observation = { ...request };
    this.observationReads.set(observation, new Map());
    return observation;
  }

  async resolveDefinitions(
    request: DeviceResourceObservationRequest,
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

  remaining(request: DeviceResourceObservationRequest): number {
    request.signal?.throwIfAborted();
    const remaining = Math.floor(request.deadlineMs - this.timer.now());
    if (remaining <= 0) {
      throw new Error("Device resource configuration timed out");
    }
    return remaining;
  }

  private async execute(
    request: DeviceResourceObservationRequest,
    args: string[],
  ): Promise<string> {
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

  async command(request: DeviceResourceObservationRequest, args: string[]): Promise<string> {
    this.remaining(request);
    const reads = this.observationReads.get(request);
    const cacheable = args[0] === "launchctl" && ["print-disabled", "print"].includes(args[1]!);
    const key = JSON.stringify(args);
    if (cacheable && reads?.has(key)) {
      return reads.get(key)!;
    }
    const read = this.execute(request, ["spawn", request.device.deviceId, ...args]);
    if (cacheable && reads) {
      reads.set(key, read);
      void read.then(undefined, () => reads.delete(key));
    }
    return read;
  }

  async readRuntimeInventory(
    request: DeviceResourceObservationRequest,
  ): Promise<Map<string, string>> {
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
    request: DeviceResourceObservationRequest,
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
          // Some runtimes omit these optional directories; absence is not a read failure.
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

  async readService(
    request: DeviceResourceObservationRequest,
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

  private async serviceLoaded(
    request: DeviceResourceObservationRequest,
    label: string,
  ): Promise<boolean> {
    try {
      await this.command(request, ["launchctl", "print", `system/${label}`]);
      return true;
    } catch (error) {
      this.remaining(request);
      if (errorMessage(error).includes(`Could not find service "${label}" in domain for system`)) {
        // An explicit launchd not-found diagnostic is evidence of absent registration.
        logger.debug(`Service is not registered: ${label}`);
        return false;
      }
      throw error;
    }
  }
}
