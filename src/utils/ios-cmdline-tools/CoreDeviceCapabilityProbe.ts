import { ActionableError } from "../../models/ActionableError";
import { SingleFlight } from "../cache/SingleFlight";
import { errorMessage } from "../describeUnknownError";
import { logger, type Logger } from "../logger";
import { compareSimctlVersions, parseSimctlVersion } from "./simctlVersion";

export type CoreDeviceVersion = [number, number, number];

/** Minimum CoreDevice release required by the planned simulator devicectl features. */
export const REQUIRED_SIMULATOR_COREDEVICE_VERSION: CoreDeviceVersion = [651, 0, 0];

/** The captured `xcrun devicectl --version` output is a dotted CoreDevice version. */
export function parseCoreDeviceVersion(output: string): CoreDeviceVersion | undefined {
  return parseSimctlVersion(output);
}

export function formatCoreDeviceVersion(version: CoreDeviceVersion): string {
  return version.join(".");
}

export type CoreDeviceVersionResult =
  | { kind: "available"; version: CoreDeviceVersion }
  | { kind: "unavailable"; reason: string }
  | { kind: "blocked"; warning: string };

/** Command classification is above output parsing. A real classifier needs captured 1001 output. */
export interface DevicectlCommandInvoker {
  invoke(deviceId: string, command: string): Promise<DevicectlCommandResult>;
}

export type DevicectlCommandResult =
  | { kind: "ok" }
  | { kind: "unsupported" }
  | { kind: "failed"; message: string };

export interface SimulatorBootStateProvider {
  getBootState(deviceId: string): Promise<"booted" | "shutdown" | "unknown">;
}

export interface CoreDeviceGuardVersionProvider {
  /**
   * Both versions must be measured for the current host and selected developer directory.
   * Reading the Xcode-bundled CoreDevice version needs a design decision and capture.
   */
  getVersions(): Promise<
    | {
        installedCoreDevice: CoreDeviceVersion;
        selectedDeveloperDirCoreDevice: CoreDeviceVersion;
      }
    | undefined
  >;
}

export interface DevicectlVersionSource {
  getDevicectlVersion(): Promise<string>;
}

export type CoreDeviceDowngradeGuard = { kind: "safe" } | { kind: "blocked"; warning: string };

/** Never enter devicectl through a developer directory with an older CoreDevice. */
export function checkCoreDeviceDowngrade(
  versions: Awaited<ReturnType<CoreDeviceGuardVersionProvider["getVersions"]>>,
): CoreDeviceDowngradeGuard {
  if (!versions) {
    return {
      kind: "blocked",
      warning:
        "Cannot verify the selected developer directory's CoreDevice version; devicectl was not run.",
    };
  }
  if (
    compareSimctlVersions(versions.selectedDeveloperDirCoreDevice, versions.installedCoreDevice) < 0
  ) {
    return {
      kind: "blocked",
      warning: `Selected developer directory bundles CoreDevice ${formatCoreDeviceVersion(versions.selectedDeveloperDirCoreDevice)}, older than installed CoreDevice ${formatCoreDeviceVersion(versions.installedCoreDevice)}; devicectl was not run. Select a compatible developer directory.`,
    };
  }
  return { kind: "safe" };
}

export type CoreDeviceCapabilityResult =
  | { kind: "supported" }
  | { kind: "unsupported"; reason: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "blocked"; warning: string }
  | { kind: "notBooted"; error: ActionableError }
  | { kind: "failed"; message: string };

export interface CoreDeviceCapabilityProbeDependencies {
  versionSource: DevicectlVersionSource;
  commandInvoker: DevicectlCommandInvoker;
  bootState: SimulatorBootStateProvider;
  guardVersions: CoreDeviceGuardVersionProvider;
  logger?: Pick<Logger, "warn">;
}

/**
 * Unwired capability probe. Version success and failure are cached for this instance's
 * lifetime, including concurrent callers. Only typed per-device unsupported results
 * are memoized; other command outcomes are retried on later calls.
 */
export class CoreDeviceCapabilityProbe {
  private versionPromise?: Promise<CoreDeviceVersionResult>;
  private readonly unsupported = new Set<string>();
  private readonly commandFlights = new SingleFlight<string, DevicectlCommandResult>();

  constructor(private readonly dependencies: CoreDeviceCapabilityProbeDependencies) {}

  async getVersion(): Promise<CoreDeviceVersionResult> {
    const guard = await this.getGuardResult();
    if (guard.kind === "blocked") {
      return guard;
    }
    this.versionPromise ??= this.probeVersion();
    return this.versionPromise;
  }

  async checkSimulatorCommand(
    deviceId: string,
    command: string,
    requiredVersion: CoreDeviceVersion,
  ): Promise<CoreDeviceCapabilityResult> {
    const version = await this.getVersion();
    if (version.kind !== "available") {
      return version;
    }
    const requirement = `requires CoreDevice >= ${formatCoreDeviceVersion(requiredVersion)}`;
    if (compareSimctlVersions(version.version, requiredVersion) < 0) {
      return { kind: "unsupported", reason: `${command} ${requirement}` };
    }

    const guard = await this.getGuardResult();
    if (guard.kind === "blocked") {
      return guard;
    }

    const bootFailure = await this.checkBootState(deviceId, command);
    if (bootFailure) {
      return bootFailure;
    }

    const key = JSON.stringify([deviceId, command]);
    if (this.unsupported.has(key)) {
      return {
        kind: "unsupported",
        reason: `${command} is unsupported by this device; ${requirement}`,
      };
    }
    let result: DevicectlCommandResult;
    try {
      result = await this.commandFlights.run(key, () =>
        this.dependencies.commandInvoker.invoke(deviceId, command),
      );
    } catch (error) {
      (this.dependencies.logger ?? logger).warn(
        `CoreDevice command ${command} failed: ${errorMessage(error)}`,
        error,
      );
      return { kind: "failed", message: errorMessage(error) };
    }
    if (result.kind === "unsupported") {
      this.unsupported.add(key);
      return {
        kind: "unsupported",
        reason: `${command} is unsupported by this device; ${requirement}`,
      };
    }
    return result.kind === "ok" ? { kind: "supported" } : result;
  }

  private async probeVersion(): Promise<CoreDeviceVersionResult> {
    try {
      const output = await this.dependencies.versionSource.getDevicectlVersion();
      const version = parseCoreDeviceVersion(output);
      if (!version) {
        const reason = "devicectl returned an unrecognized CoreDevice version";
        (this.dependencies.logger ?? logger).warn(reason);
        return { kind: "unavailable", reason };
      }
      return { kind: "available", version };
    } catch (error) {
      (this.dependencies.logger ?? logger).warn(
        `CoreDevice version probe failed: ${errorMessage(error)}`,
        error,
      );
      return {
        kind: "unavailable",
        reason: `CoreDevice version probe failed: ${errorMessage(error)}`,
      };
    }
  }

  private async getGuardResult(): Promise<CoreDeviceDowngradeGuard> {
    try {
      return checkCoreDeviceDowngrade(await this.dependencies.guardVersions.getVersions());
    } catch (error) {
      (this.dependencies.logger ?? logger).warn(
        `CoreDevice downgrade guard failed: ${errorMessage(error)}`,
        error,
      );
      return {
        kind: "blocked",
        warning: `Cannot verify the selected developer directory's CoreDevice version: ${errorMessage(error)}; devicectl was not run.`,
      };
    }
  }

  private async checkBootState(
    deviceId: string,
    command: string,
  ): Promise<CoreDeviceCapabilityResult | undefined> {
    let bootState: "booted" | "shutdown" | "unknown";
    try {
      bootState = await this.dependencies.bootState.getBootState(deviceId);
    } catch (error) {
      (this.dependencies.logger ?? logger).warn(
        `CoreDevice simulator boot check failed: ${errorMessage(error)}`,
        error,
      );
      return {
        kind: "unavailable",
        reason: `Cannot verify simulator boot state: ${errorMessage(error)}`,
      };
    }
    if (bootState === "booted") {
      return undefined;
    }
    return {
      kind: "notBooted",
      error: new ActionableError(
        bootState === "shutdown"
          ? `Simulator ${deviceId} is shut down. Boot it before running ${command}.`
          : `Cannot confirm simulator ${deviceId} is booted. Check its state before running ${command}.`,
      ),
    };
  }
}
