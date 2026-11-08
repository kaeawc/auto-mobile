import type { BootedDevice } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { iosVersionFromSimctlListDevices } from "../../utils/ios-cmdline-tools/iosVersion";
import { parseXcodeVersion, type Xcodebuild } from "../../utils/ios-cmdline-tools/XcodebuildClient";
import { logger } from "../../utils/logger";

/** An Xcode and simulator runtime pair on which `xctrace record` cannot finalise a trace. */
export interface XctraceBrokenCombination {
  /** Dotted Xcode version prefix: `"26.6"` matches 26.6 and 26.6.x. */
  readonly xcodeVersion: string;
  /** Dotted iOS simulator runtime prefix: `"26.5"` matches 26.5 and 26.5.x. */
  readonly simulatorRuntime: string;
}

/**
 * Known-broken pairs. On each, xctrace hangs in finalisation after SIGINT, a time
 * limit or SIGTERM and leaves a trace bundle with no run data (#16999).
 */
export const XCTRACE_BROKEN_COMBINATIONS: readonly XctraceBrokenCombination[] = [
  { xcodeVersion: "26.6", simulatorRuntime: "26.5" },
];

/** What the recorder needs to know about the host Xcode and the target simulator. */
export interface XctraceEnvironment {
  /** Active Xcode version (e.g. `"26.6"`); `undefined` when it cannot be read. */
  xcodeVersion(signal?: AbortSignal): Promise<string | undefined>;
  /** iOS runtime of a simulator (e.g. `"26.5"`); `undefined` for physical devices or when unknown. */
  simulatorRuntime(device: BootedDevice, signal?: AbortSignal): Promise<string | undefined>;
}

function versionHasPrefix(version: string, prefix: string): boolean {
  const parts = version.trim().split(".");
  return prefix.split(".").every((part, index) => parts[index] === part);
}

/** The table row matching this Xcode and runtime; unknown versions never match. */
export function findBrokenXctraceCombination(
  xcodeVersion: string | undefined,
  simulatorRuntime: string | undefined,
  table: readonly XctraceBrokenCombination[] = XCTRACE_BROKEN_COMBINATIONS,
): XctraceBrokenCombination | undefined {
  if (!xcodeVersion || !simulatorRuntime) {
    return undefined;
  }
  return table.find(
    (row) =>
      versionHasPrefix(xcodeVersion, row.xcodeVersion) &&
      versionHasPrefix(simulatorRuntime, row.simulatorRuntime),
  );
}

const XCODE_VERSION_TIMEOUT_MS = 10_000;
const SIMCTL_LIST_TIMEOUT_MS = 10_000;

export interface HostXctraceEnvironmentDependencies {
  xcodebuild: Pick<Xcodebuild, "executeCommand">;
  /** `simctl list --json devices <udid>` stdout for the device. */
  listSimulatorDevices: (
    device: BootedDevice,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<string>;
}

/** Reads the versions from `xcodebuild -version` and simctl; any failure reads as unknown. */
export class HostXctraceEnvironment implements XctraceEnvironment {
  /** The selected Xcode does not change under a running daemon, so a read version is kept. */
  private cachedXcodeVersion?: string;

  constructor(private readonly deps: HostXctraceEnvironmentDependencies) {}

  async xcodeVersion(signal?: AbortSignal): Promise<string | undefined> {
    if (this.cachedXcodeVersion) {
      return this.cachedXcodeVersion;
    }
    try {
      const { stdout } = await this.deps.xcodebuild.executeCommand(["-version"], {
        timeoutMs: XCODE_VERSION_TIMEOUT_MS,
        signal,
      });
      this.cachedXcodeVersion = parseXcodeVersion(stdout) ?? undefined;
      return this.cachedXcodeVersion;
    } catch (error) {
      signal?.throwIfAborted();
      // Unknown Xcode skips only the known-broken precheck; xctrace still runs as before.
      logger.warn(`[performanceTrace] xcodebuild -version failed: ${errorMessage(error)}`, error);
      return undefined;
    }
  }

  async simulatorRuntime(device: BootedDevice, signal?: AbortSignal): Promise<string | undefined> {
    if (resolveIosDeviceKind({ deviceId: device.deviceId }) !== "simulator") {
      return undefined;
    }
    if (device.iosVersion) {
      return device.iosVersion;
    }
    try {
      const json = await this.deps.listSimulatorDevices(device, SIMCTL_LIST_TIMEOUT_MS, signal);
      return iosVersionFromSimctlListDevices(json, device.deviceId);
    } catch (error) {
      signal?.throwIfAborted();
      // Unknown runtime skips only the known-broken precheck; xctrace still runs as before.
      logger.warn(
        `[performanceTrace] simctl list devices ${device.deviceId} failed: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }
}
