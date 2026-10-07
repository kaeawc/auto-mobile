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

export type CoreDeviceVersionMeasurement =
  | { kind: "available"; version: CoreDeviceVersion }
  | { kind: "unavailable"; reason: string; reasonKind?: "missing" | "unparsable" };

/** The invoker classifies the captured structured CoreDevice failure envelope. */
export interface DevicectlCommandInvoker {
  invoke(deviceId: string, command: string): Promise<DevicectlCommandResult>;
}

export type DevicectlCommandResult =
  /** `output` is this invocation's raw `--json-output` text; it is never memoized. */
  | { kind: "ok"; output?: string }
  | { kind: "unsupported"; capabilityFeatureId?: string }
  | { kind: "failed"; message: string };

export interface SimulatorBootStateProvider {
  getBootState(deviceId: string): Promise<"booted" | "shutdown" | "unknown">;
  getCapabilityScope?(deviceId: string): string;
  readSummary?(options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<SimulatorBootSummary>;
}

export interface DevicectlVersionSource {
  getDevicectlVersion(): Promise<string>;
}

export type CoreDeviceCapabilityResult =
  /** `output` lets the caller read this check's own JSON instead of running the command twice. */
  | { kind: "supported"; output?: string }
  | { kind: "unsupported"; reason: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "notBooted"; error: ActionableError }
  | { kind: "failed"; message: string };

export interface CoreDeviceCapabilityProbeDependencies {
  versionSource: DevicectlVersionSource;
  commandInvoker: DevicectlCommandInvoker;
  bootState: SimulatorBootStateProvider;
  logger?: Pick<Logger, "warn">;
}

export type SimulatorBootSummary =
  | { status: "available"; booted: number; shutdown: number; unknown: number }
  | { status: "unavailable"; reason: string };

export interface CoreDeviceCapabilities {
  status: "not probed" | "probed";
  entries: Array<{
    scope: string;
    command: string;
    featureId?: string;
    status: "supported" | "unsupported";
  }>;
}

export interface CoreDeviceProbeDiagnostics {
  getCachedVersion(): CoreDeviceVersionMeasurement | undefined;
  recordVersion(result: CoreDeviceVersionMeasurement): void;
  refreshVersion(
    read: () => Promise<CoreDeviceVersionMeasurement>,
  ): Promise<CoreDeviceVersionMeasurement>;
  getCapabilities(): CoreDeviceCapabilities;
  readSimulatorBootState(options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<SimulatorBootSummary>;
}

export const COREDEVICE_MEMO_LIMIT = 64;

/**
 * Lazy process-owned probe. Only a real caller of checkSimulatorCommand triggers
 * capabilities; diagnostic reads refresh --version and read simctl state.
 * Unsupported feature IDs are scoped to simulator device type/runtime (or UDID when
 * unknown): a non-Duo's hinge failure must not disable a Duo. Both maps use FIFO
 * eviction; failed commands are never retained. No localized text is a key.
 */
export class CoreDeviceCapabilityProbe implements CoreDeviceProbeDiagnostics {
  private versionPromise?: Promise<CoreDeviceVersionMeasurement>;
  private cachedVersion?: CoreDeviceVersionMeasurement;
  private versionRevision = 0;
  private readonly features = new Map<string, { scope: string; featureId: string }>();
  private readonly commands = new Map<string, CoreDeviceCapabilities["entries"][number]>();
  private readonly commandFlights = new SingleFlight<string, DevicectlCommandResult>();

  constructor(private readonly dependencies: CoreDeviceCapabilityProbeDependencies) {}

  getCachedVersion(): CoreDeviceVersionMeasurement | undefined {
    const result = this.cachedVersion;
    return result?.kind === "available" ? { ...result, version: [...result.version] } : result;
  }

  getCapabilities(): CoreDeviceCapabilities {
    const entries = [...this.commands.values()].map((entry) => ({ ...entry }));
    return { status: entries.length ? "probed" : "not probed", entries };
  }

  async readSimulatorBootState(
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<SimulatorBootSummary> {
    if (!this.dependencies.bootState.readSummary) {
      return { status: "unavailable", reason: "simulator state provider not configured" };
    }
    const log = this.dependencies.logger ?? logger;
    try {
      return await this.dependencies.bootState.readSummary(options);
    } catch (error) {
      log.warn(`CoreDevice simulator state read failed: ${errorMessage(error)}`, error);
      return { status: "unavailable", reason: errorMessage(error) };
    }
  }

  /** Seed a measured result, including failures that invalidate an earlier success. */
  recordVersion(result: CoreDeviceVersionMeasurement): void {
    this.versionRevision += 1;
    this.cachedVersion =
      result.kind === "available" ? { ...result, version: [...result.version] } : { ...result };
  }

  /** Refresh diagnostics on every read, sharing any version invocation already in flight. */
  refreshVersion(
    read: () => Promise<CoreDeviceVersionMeasurement>,
  ): Promise<CoreDeviceVersionMeasurement> {
    if (this.versionPromise) {
      return this.versionPromise;
    }
    const revision = this.versionRevision;
    const pending = Promise.resolve()
      .then(read)
      .then((result) => {
        if (revision === this.versionRevision) {
          this.recordVersion(result);
        }
        return this.getCachedVersion() ?? result;
      });
    this.versionPromise = pending;
    const clear = () => {
      if (this.versionPromise === pending) {
        this.versionPromise = undefined;
      }
    };
    void pending.then(clear, clear);
    return pending;
  }

  async getVersion(): Promise<CoreDeviceVersionMeasurement> {
    if (this.versionPromise) {
      return this.versionPromise;
    }
    const cached = this.getCachedVersion();
    return cached?.kind === "available" ? cached : this.refreshVersion(() => this.probeVersion());
  }

  async checkSimulatorCommand(
    deviceId: string,
    command: string,
    requiredVersion: CoreDeviceVersion,
  ): Promise<CoreDeviceCapabilityResult> {
    // Boot comes before even --version: 1001 on an off simulator is not evidence.
    const bootFailure = await this.checkBootState(deviceId, command);
    if (bootFailure) {
      return bootFailure;
    }
    const version = await this.getVersion();
    if (version.kind !== "available") {
      return version;
    }
    const requirement = `requires CoreDevice >= ${formatCoreDeviceVersion(requiredVersion)}`;
    if (compareSimctlVersions(version.version, requiredVersion) < 0) {
      return { kind: "unsupported", reason: `${command} ${requirement}` };
    }

    const scope = this.dependencies.bootState.getCapabilityScope?.(deviceId) ?? deviceId;
    const key = JSON.stringify([scope, command]);
    const learned = this.commands.get(key);
    if (learned?.featureId && this.features.has(JSON.stringify([scope, learned.featureId]))) {
      return this.unsupportedResult(command, requirement);
    }
    let result: DevicectlCommandResult;
    try {
      result = await this.commandFlights.run(JSON.stringify([deviceId, command]), () =>
        this.dependencies.commandInvoker.invoke(deviceId, command),
      );
    } catch (error) {
      (this.dependencies.logger ?? logger).warn(
        `CoreDevice command ${command} failed: ${errorMessage(error)}`,
        error,
      );
      return { kind: "failed", message: errorMessage(error) };
    }
    return this.recordCommandResult(result, { scope, key, command, requirement });
  }

  private recordCommandResult(
    result: DevicectlCommandResult,
    options: { scope: string; key: string; command: string; requirement: string },
  ): CoreDeviceCapabilityResult {
    const { scope, key, command, requirement } = options;
    if (result.kind === "unsupported") {
      // A 1001 without a stable feature ID is reported, but cannot be memoized.
      if (result.capabilityFeatureId) {
        this.rememberFeature(scope, result.capabilityFeatureId);
        this.rememberCommand(key, {
          scope,
          command,
          featureId: result.capabilityFeatureId,
          status: "unsupported",
        });
      }
      return this.unsupportedResult(command, requirement);
    }
    if (result.kind === "ok") {
      this.rememberCommand(key, { scope, command, status: "supported" });
      return result.output === undefined
        ? { kind: "supported" }
        : { kind: "supported", output: result.output };
    }
    return result;
  }

  private unsupportedResult(command: string, requirement: string): CoreDeviceCapabilityResult {
    return {
      kind: "unsupported",
      reason: `${command} is unsupported by this simulator type; ${requirement}`,
    };
  }

  private rememberFeature(scope: string, featureId: string): void {
    const key = JSON.stringify([scope, featureId]);
    if (!this.features.has(key) && this.features.size >= COREDEVICE_MEMO_LIMIT) {
      const oldest = this.features.keys().next().value;
      if (oldest !== undefined) {
        this.features.delete(oldest);
        this.forgetFeatureCommands(oldest);
      }
    }
    this.features.set(key, { scope, featureId });
  }

  private forgetFeatureCommands(key: string): void {
    for (const [commandKey, entry] of this.commands) {
      if (JSON.stringify([entry.scope, entry.featureId]) === key) {
        this.commands.delete(commandKey);
      }
    }
  }

  private rememberCommand(key: string, entry: CoreDeviceCapabilities["entries"][number]): void {
    if (!this.commands.has(key) && this.commands.size >= COREDEVICE_MEMO_LIMIT) {
      const oldest = this.commands.keys().next().value;
      if (oldest !== undefined) {
        this.commands.delete(oldest);
      }
    }
    this.commands.set(key, entry);
  }

  private async probeVersion(): Promise<CoreDeviceVersionMeasurement> {
    try {
      const output = await this.dependencies.versionSource.getDevicectlVersion();
      const version = parseCoreDeviceVersion(output);
      if (!version) {
        const reason = "devicectl returned an unrecognized CoreDevice version";
        (this.dependencies.logger ?? logger).warn(reason);
        return { kind: "unavailable", reason, reasonKind: "unparsable" };
      }
      return { kind: "available", version };
    } catch (error) {
      (this.dependencies.logger ?? logger).warn(
        `CoreDevice version probe failed: ${errorMessage(error)}`,
        error,
      );
      return {
        kind: "unavailable",
        reason: `devicectl not functional: ${errorMessage(error)}`,
        reasonKind: "missing",
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
        kind: "notBooted",
        error: new ActionableError(
          `Cannot confirm simulator ${deviceId} is booted: ${errorMessage(error)}. Check its state before running ${command}.`,
        ),
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
