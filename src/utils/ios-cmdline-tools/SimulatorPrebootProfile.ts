import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  findUnsafeResourceCombinations,
  iosDeviceResourceHazards,
  type IosDeviceResourceHazard,
} from "../iosDeviceResourceHazards";
import { UnsafeDeviceResourceCombinationError } from "../../models/UnsafeDeviceResourceCombinationError";
import { ENV, readEnvTrimmed } from "../../config/env";
import type {
  ConfigurableDeviceResource,
  DeviceResourceConfiguration,
} from "../../models/DeviceResourceConfiguration";
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
export const PREBOOT_LEAN_PROFILE_DEFAULT: PrebootLeanProfileName = "minimal";
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
    return PREBOOT_LEAN_PROFILE_DEFAULT;
  }
  if (value === "none" || value === "minimal" || value === "catalog-cpu") {
    return value;
  }
  logger.warn(`Unknown iOS preboot lean profile '${value}'; using ${PREBOOT_LEAN_PROFILE_DEFAULT}`);
  return PREBOOT_LEAN_PROFILE_DEFAULT;
}

export function resolveApsdLogSuppressionEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = readEnvTrimmed(ENV.IOS_SUPPRESS_APSD_LOG, env)?.toLowerCase();
  return value === "1" || value === "true";
}

export const simulatorHostStateDir = (udid: string): string =>
  `/private/var/tmp/com.apple.CoreSimulator.SimDevice.${udid.toUpperCase()}`;
export const simulatorDisabledDbPath = (udid: string): string =>
  `${simulatorHostStateDir(udid)}/disabled.plist`;

export interface PrebootApplyResult {
  applied: boolean;
  resources: ConfigurableDeviceResource[];
  labels: string[];
  path?: string;
  reason?: string;
  unsafe?: readonly IosDeviceResourceHazard[];
  apsdLogSuppression?: { applied: boolean; path?: string; reason?: string };
}

export class SimulatorPrebootProfile {
  constructor(
    private readonly host: SimulatorHostState = new NodeSimulatorHostState(),
    private readonly defaultProfile: () => PrebootLeanProfileName = () =>
      resolveDefaultPrebootProfile(process.env),
    private readonly hazards: readonly IosDeviceResourceHazard[] = iosDeviceResourceHazards,
    private readonly apsdLog: { enabled: () => boolean; devicesDir: () => string } = {
      enabled: () => resolveApsdLogSuppressionEnabled(process.env),
      devicesDir: () => join(homedir(), "Library/Developer/CoreSimulator/Devices"),
    },
  ) {}
  async apply(
    udid: string,
    { resources }: { resources?: DeviceResourceConfiguration },
    signal?: AbortSignal,
  ): Promise<PrebootApplyResult> {
    if (!isIosSimulatorUdid(udid)) {
      return { applied: false, resources: [], labels: [], reason: "Invalid simulator UDID" };
    }
    let labels: string[] = [];
    let suppression: Pick<PrebootApplyResult, "apsdLogSuppression"> = {};
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
        return { applied: false, resources: [], labels: [], reason: refusal.message, unsafe };
      }
      labels = resolvePrebootLabels(options);
      suppression = await this.suppressApsdLogs(udid, signal);
      signal?.throwIfAborted();
      if (!labels.length) {
        return { applied: false, resources: [], labels: [], ...suppression };
      }
      const path = simulatorDisabledDbPath(udid);
      await this.host.mkdirPrivate(simulatorHostStateDir(udid));
      const existing = await this.host.readExisting(path, signal);
      signal?.throwIfAborted();
      await this.host.writeBinaryPlist(
        path,
        { ...existing, ...Object.fromEntries(labels.map((label) => [label, true])) },
        signal,
      );
      return {
        applied: true,
        resources: resolvePrebootResources(options),
        labels,
        path,
        ...suppression,
      };
    } catch (error) {
      if (signal?.aborted) {
        // Cancellation is expected when the provisioning request ends.
        logger.debug("Simulator preboot profile apply aborted", error);
        return { applied: false, resources: [], labels, reason: "aborted", ...suppression };
      }
      logger.warn(`Failed to apply simulator preboot profile: ${errorMessage(error)}`, error);
      return { applied: false, resources: [], labels, reason: errorMessage(error), ...suppression };
    }
  }
  private async suppressApsdLogs(
    udid: string,
    signal?: AbortSignal,
  ): Promise<Pick<PrebootApplyResult, "apsdLogSuppression">> {
    try {
      if (!this.apsdLog.enabled()) {
        return {};
      }
      signal?.throwIfAborted();
      const path = join(
        this.apsdLog.devicesDir(),
        udid.toUpperCase(),
        "data/Library/Preferences/Logging/Subsystems/com.apple.apsd.plist",
      );
      await this.host.mkdirPrivate(dirname(path));
      signal?.throwIfAborted();
      await this.host.writeBinaryPlist(
        path,
        { "DEFAULT-OPTIONS": { Level: { Enable: "off", Persist: "off" } } },
        signal,
      );
      return { apsdLogSuppression: { applied: true, path } };
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      logger.warn(`Failed to suppress simulator apsd logs: ${errorMessage(error)}`, error);
      return { apsdLogSuppression: { applied: false, reason: errorMessage(error) } };
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
