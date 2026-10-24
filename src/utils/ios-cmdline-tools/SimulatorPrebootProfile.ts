import {
  findUnsafeResourceCombinations,
  iosDeviceResourceHazards,
  type IosDeviceResourceHazard,
} from "../iosDeviceResourceHazards";
import { UnsafeDeviceResourceCombinationError } from "../../models/UnsafeDeviceResourceCombinationError";
import { ENV, readEnvTrimmed } from "../../config/env";
import type { DeviceResourceConfiguration } from "../../models/DeviceResourceConfiguration";
import { iosDeviceResourceCatalog } from "../iosDeviceResourceCatalog";
import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import { isIosSimulatorUdid } from "./iosDeviceType";
import {
  NodeSimulatorHostState,
  isMissingSimulatorHostState,
  type SimulatorHostState,
} from "./NodeSimulatorHostState";
export type { SimulatorHostState } from "./NodeSimulatorHostState";

export type PrebootLeanProfileName = "none" | "minimal" | "catalog-cpu";
export const PREBOOT_LEAN_PROFILES = {
  none: [],
  minimal: ["wallpaperRendering", "widgets", "liveActivities"],
  "catalog-cpu": [
    "wallpaperRendering",
    "widgets",
    "liveActivities",
    "healthServices",
    "photoAnalysis",
    "assistantSuggestions",
    "appleIntelligence",
    "searchIndexing",
  ],
} as const satisfies Record<
  PrebootLeanProfileName,
  readonly (keyof typeof iosDeviceResourceCatalog)[]
>;

function resolvePrebootResources({
  profile,
  resources = {},
}: {
  profile: PrebootLeanProfileName;
  resources?: DeviceResourceConfiguration;
}): (keyof typeof iosDeviceResourceCatalog)[] {
  const selected = new Set<keyof typeof iosDeviceResourceCatalog>(PREBOOT_LEAN_PROFILES[profile]);
  for (const key of Object.keys(
    iosDeviceResourceCatalog,
  ) as (keyof typeof iosDeviceResourceCatalog)[]) {
    if (resources[key] === "disabled") {
      selected.add(key);
    } else if (resources[key] === "enabled") {
      selected.delete(key);
    }
  }
  return [...selected];
}

export function resolvePrebootLabels(options: {
  profile: PrebootLeanProfileName;
  resources?: DeviceResourceConfiguration;
}): string[] {
  return [
    ...new Set(
      resolvePrebootResources(options).flatMap((key) => [...iosDeviceResourceCatalog[key]]),
    ),
  ].sort();
}

export function resolveDefaultPrebootProfile(env: NodeJS.ProcessEnv): PrebootLeanProfileName {
  const value = readEnvTrimmed(ENV.IOS_PREBOOT_LEAN_PROFILE, env);
  if (value === undefined) {
    return "none";
  }
  if (value === "none" || value === "minimal" || value === "catalog-cpu") {
    return value;
  }
  logger.warn(`Unknown iOS preboot lean profile '${value}'; using none`);
  return "none";
}

export const simulatorHostStateDir = (udid: string): string =>
  `/private/var/tmp/com.apple.CoreSimulator.SimDevice.${udid.toUpperCase()}`;
export const simulatorDisabledDbPath = (udid: string): string =>
  `${simulatorHostStateDir(udid)}/disabled.plist`;

export interface PrebootApplyResult {
  applied: boolean;
  labels: string[];
  path?: string;
  reason?: string;
  unsafe?: readonly IosDeviceResourceHazard[];
}

export class SimulatorPrebootProfile {
  constructor(
    private readonly host: SimulatorHostState = new NodeSimulatorHostState(),
    private readonly defaultProfile: () => PrebootLeanProfileName = () =>
      resolveDefaultPrebootProfile(process.env),
    private readonly hazards: readonly IosDeviceResourceHazard[] = iosDeviceResourceHazards,
  ) {}
  async apply(
    udid: string,
    { resources }: { resources?: DeviceResourceConfiguration },
    signal?: AbortSignal,
  ): Promise<PrebootApplyResult> {
    if (!isIosSimulatorUdid(udid)) {
      return { applied: false, labels: [], reason: "Invalid simulator UDID" };
    }
    let labels: string[] = [];
    try {
      signal?.throwIfAborted();
      const options = { profile: this.defaultProfile(), resources };
      const unsafe = findUnsafeResourceCombinations(
        resolvePrebootResources(options),
        this.hazards,
        "preboot",
      );
      if (unsafe.length) {
        const refusal = new UnsafeDeviceResourceCombinationError(unsafe);
        logger.warn(refusal.message);
        return { applied: false, labels: [], reason: refusal.message, unsafe };
      }
      labels = resolvePrebootLabels(options);
      if (!labels.length) {
        return { applied: false, labels: [] };
      }
      signal?.throwIfAborted();
      const path = simulatorDisabledDbPath(udid);
      await this.host.mkdirPrivate(simulatorHostStateDir(udid));
      const existing = await this.host.readExisting(path, signal);
      signal?.throwIfAborted();
      await this.host.writeBinaryPlist(
        path,
        { ...existing, ...Object.fromEntries(labels.map((label) => [label, true])) },
        signal,
      );
      return { applied: true, labels, path };
    } catch (error) {
      if (signal?.aborted) {
        // Cancellation is expected when the provisioning request ends.
        logger.debug("Simulator preboot profile apply aborted", error);
        return { applied: false, labels, reason: "aborted" };
      }
      logger.warn(`Failed to apply simulator preboot profile: ${errorMessage(error)}`, error);
      return { applied: false, labels, reason: errorMessage(error) };
    }
  }
  async removeHostState(udid: string): Promise<void> {
    if (!isIosSimulatorUdid(udid)) {
      return;
    }
    try {
      await this.host.rmDir(simulatorHostStateDir(udid));
    } catch (error) {
      if (isMissingSimulatorHostState(error)) {
        // A deleted simulator may never have had a profile; absent state is already clean.
        logger.debug(`No simulator host state to remove for ${udid}`);
      } else {
        logger.warn(`Failed to remove simulator host state: ${errorMessage(error)}`, error);
      }
    }
  }
}
