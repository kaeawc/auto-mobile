import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { z } from "zod/v4";
import { combineWithAmbientAbort, throwIfRequestAborted } from "../../utils/AbortContext";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../utils/HostCommandExecutor";
import { logger } from "../../utils/logger";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { defaultDeviceSetRoot } from "../../utils/ios-cmdline-tools/SimulatorTccSqliteClient";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";

/**
 * Host bridge to the macOS Network Extension controller (#10590, plan #6298).
 *
 * The daemon never talks XPC to the provider: the provider only accepts peers
 * signed by its own team. Instead it runs the installed
 * `network-filter-controller` as a subprocess and parses the one JSON line it
 * prints (`ControllerResult` in ios/network-filter, documented in that
 * package's README).
 */

/**
 * The controller JSON contract version this daemon understands. Must match
 * `ControllerContract.version` in
 * ios/network-filter/Sources/NetworkFilterCore/ControllerContract.swift.
 * Version 2 ships with per-simulator attribution (#10589): `status`/`snapshot`
 * take `--managed` pairs and the snapshot reports per-flow attribution. There
 * is no version 1 fallback.
 */
export const NETWORK_FILTER_CONTRACT_VERSION = 2;

/** The controller rejects more `--managed` pairs than this (`ManagedSimulator.maximumCount`). */
export const NETWORK_FILTER_MAX_MANAGED_SIMULATORS = 256;

/**
 * SystemExtensions only activates an extension whose containing app is in
 * /Applications, so the installer (#10588) puts the app here and the bridge
 * looks only here. The bundle name comes from
 * ios/network-filter/Packaging/Controller-Info.plist (`CFBundleName`).
 */
export const NETWORK_FILTER_APP_BUNDLE_NAME = "AutoMobile Network Identity Probe.app";
export const DEFAULT_NETWORK_FILTER_CONTROLLER_PATH = `/Applications/${NETWORK_FILTER_APP_BUNDLE_NAME}/Contents/MacOS/network-filter-controller`;

/** The opt-in install command the installer (#10588) exposes. */
export const NETWORK_FILTER_INSTALL_COMMAND = "auto-mobile --ios-network-filter install";

/**
 * The controller abandons its own work after 8 s (including its ~2.2 s
 * read-back retry budget) and prints `unavailable`. Allow headroom for process
 * startup so its own answer wins over a kill.
 */
export const NETWORK_FILTER_CONTROLLER_TIMEOUT_MS = 12_000;

/** A controller result is one short JSON line; anything near this is malformed. */
const CONTROLLER_MAX_BUFFER_BYTES = 1024 * 1024;

/** States the controller itself prints. */
export const networkFilterControllerStateSchema = z.enum([
  "installation_required",
  "approval_required",
  "unavailable",
  "ready",
]);
export type NetworkFilterControllerState = z.infer<typeof networkFilterControllerStateSchema>;

/** Controller states plus `not_installed`, when no controller exists at the expected path. */
export type NetworkFilterState = NetworkFilterControllerState | "not_installed";

/** A simulator the host lets the provider attribute flows to. */
const managedSimulatorSchema = z.object({ deviceSet: z.string(), udid: z.string() });
export type ManagedSimulator = z.infer<typeof managedSimulatorSchema>;

/**
 * One observed flow (snapshot v2, #10589). Every attribution field is optional:
 * a flow the provider could not attribute carries `attribution: "unattributed"`
 * and a `reason`, or nothing at all. `method` and `reason` stay open strings so
 * a new provider-side reason does not make the whole snapshot unreadable.
 */
const networkFilterFlowSchema = z.object({
  sourceApp: z.unknown().optional(),
  sourceProcess: z.unknown().optional(),
  delegated: z.boolean().optional(),
  attribution: z.enum(["attributed", "unattributed", "conflicting"]).optional(),
  method: z.string().optional(),
  simulator: z.object({ udid: z.string(), deviceSet: z.string(), method: z.string() }).optional(),
  app: z
    .object({
      bundleId: z.string().optional(),
      executablePath: z.string(),
      pid: z.number().int(),
      pidVersion: z.number().int(),
    })
    .optional(),
  reason: z.string().optional(),
});

/** The provider's diagnostic snapshot; its own `version` evolves with the provider. */
const networkFilterSnapshotSchema = z.object({
  version: z.number().int(),
  backend: z.string(),
  mode: z.string(),
  observedFlows: z.number().int().nonnegative(),
  discardedFlows: z.number().int().nonnegative(),
  managedSimulators: z.array(managedSimulatorSchema).optional(),
  flows: z.array(networkFilterFlowSchema),
  limitations: z.array(z.string()),
});
export type NetworkFilterSnapshot = z.infer<typeof networkFilterSnapshotSchema>;

const controllerVersionSchema = z.object({ version: z.number().int() });

const controllerResultSchema = z.object({
  version: z.literal(NETWORK_FILTER_CONTRACT_VERSION),
  state: networkFilterControllerStateSchema,
  detail: z.string(),
  snapshot: networkFilterSnapshotSchema.optional(),
});

export interface NetworkFilterStatus {
  state: NetworkFilterState;
  /** The controller's own detail, or why the bridge could not get an answer. */
  detail: string;
  /** Contract version the controller reported; absent when it gave no valid answer. */
  contractVersion?: number;
}

export interface NetworkFilterSnapshotResult extends NetworkFilterStatus {
  /** Present only when the controller reached the provider (`ready`). */
  snapshot?: NetworkFilterSnapshot;
}

/**
 * Read-only bridge. Neither method throws: every failure (missing binary,
 * timeout, malformed output, contract mismatch) resolves to a typed state.
 * `apply`/`reset`/`renew` arrive with #10264.
 */
export interface NetworkFilterBridge {
  status(): Promise<NetworkFilterStatus>;
  snapshot(): Promise<NetworkFilterSnapshotResult>;
}

export interface ExecNetworkFilterBridgeOptions {
  executor?: HostCommandExecutor;
  /** The host's booted simulators, passed as `--managed` pairs; defaults to simctl. */
  managedSimulators?: () => Promise<ManagedSimulator[]>;
  /** Absolute path to `network-filter-controller`; injectable for tests and local builds. */
  controllerPath?: string;
  exists?: (path: string) => boolean;
  timeoutMs?: number;
}

/** What an exec failure may carry; read structurally from the error or its cause. */
const execFailureSchema = z.object({
  code: z.union([z.string(), z.number()]).optional(),
  stdout: z.union([z.string(), z.instanceof(Buffer)]).optional(),
});

function execFailureDetails(error: unknown): { code?: string | number; stdout: string } {
  // runExecSeam wraps the raw execFile error; the raw one (with code/stdout) is its cause.
  const candidates = error instanceof Error ? [error, error.cause] : [error];
  const details = candidates
    .map((candidate) => execFailureSchema.safeParse(candidate))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
  const code = details.find((detail) => detail.code !== undefined)?.code;
  const stdout = details.find((detail) => detail.stdout !== undefined)?.stdout ?? "";
  return { code, stdout: stdout.toString() };
}

export interface ManagedSimulatorListerDependencies {
  listBootedSimulators?: () => Promise<Array<{ deviceId: string }>>;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: () => string;
}

/**
 * The host's booted simulators in the active device set
 * (`CORESIMULATOR_DEVICE_SET_PATH` when set, else the default set). The
 * controller canonicalizes the set path itself (realpath). A listing failure
 * yields no pairs: the controller then reports every flow unattributed, which
 * never widens what can be selected.
 */
export function createManagedSimulatorLister(
  dependencies: ManagedSimulatorListerDependencies = {},
): () => Promise<ManagedSimulator[]> {
  const listBooted =
    dependencies.listBootedSimulators ?? (() => new SimCtlClient().getBootedSimulatorsChecked());
  return async () => {
    let booted: Array<{ deviceId: string }>;
    try {
      booted = await listBooted();
    } catch (error) {
      // A cancelled request is not a listing failure: surface the abort.
      throwIfRequestAborted();
      logger.warn(
        `[NetworkFilterBridge] listing booted simulators failed: ${errorMessage(error)}`,
        error,
      );
      return [];
    }
    const deviceSet = defaultDeviceSetRoot(
      (dependencies.homeDirectory ?? homedir)(),
      dependencies.environment ?? process.env,
    );
    const udids = [...new Set(booted.map((device) => device.deviceId))].filter(
      (deviceId) => resolveIosDeviceKind({ deviceId }) === "simulator",
    );
    return udids
      .slice(0, NETWORK_FILTER_MAX_MANAGED_SIMULATORS)
      .map((udid) => ({ deviceSet, udid }));
  };
}

function managedArguments(simulators: readonly ManagedSimulator[]): string[] {
  return simulators.flatMap((simulator) => ["--managed", simulator.deviceSet, simulator.udid]);
}

function lastNonEmptyLine(stdout: string): string | undefined {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
}

/** Runs the installed controller through the host exec seam. */
export class ExecNetworkFilterBridge implements NetworkFilterBridge {
  private readonly executor: HostCommandExecutor;
  private readonly controllerPath: string;
  private readonly exists: (path: string) => boolean;
  private readonly timeoutMs: number;
  private readonly managedSimulators: () => Promise<ManagedSimulator[]>;

  constructor(options: ExecNetworkFilterBridgeOptions = {}) {
    this.executor = options.executor ?? new DefaultHostCommandExecutor();
    this.controllerPath = options.controllerPath ?? DEFAULT_NETWORK_FILTER_CONTROLLER_PATH;
    this.exists = options.exists ?? existsSync;
    this.timeoutMs = options.timeoutMs ?? NETWORK_FILTER_CONTROLLER_TIMEOUT_MS;
    this.managedSimulators = options.managedSimulators ?? createManagedSimulatorLister();
  }

  async status(): Promise<NetworkFilterStatus> {
    const result = await this.run("status");
    return {
      state: result.state,
      detail: result.detail,
      ...(result.contractVersion !== undefined ? { contractVersion: result.contractVersion } : {}),
    };
  }

  snapshot(): Promise<NetworkFilterSnapshotResult> {
    return this.run("snapshot");
  }

  private notInstalled(): NetworkFilterSnapshotResult {
    return {
      state: "not_installed",
      detail: `No network-filter-controller at ${this.controllerPath}.`,
    };
  }

  private unavailable(detail: string): NetworkFilterSnapshotResult {
    return { state: "unavailable", detail };
  }

  private async run(command: "status" | "snapshot"): Promise<NetworkFilterSnapshotResult> {
    if (!this.exists(this.controllerPath)) {
      return this.notInstalled();
    }
    const managed = managedArguments(await this.managedSimulators());
    let stdout: string;
    try {
      const result = await this.executor.executeCommand(
        this.controllerPath,
        [command, ...managed],
        {
          timeoutMs: this.timeoutMs,
          maxBuffer: CONTROLLER_MAX_BUFFER_BYTES,
          signal: combineWithAmbientAbort(),
        },
      );
      stdout = result.stdout;
    } catch (error) {
      // A cancelled request is not an `unavailable` controller.
      throwIfRequestAborted();
      const failure = execFailureDetails(error);
      if (failure.code === "ENOENT") {
        // Removed between the existence check and the exec.
        return this.notInstalled();
      }
      // The controller exits non-zero for every non-ready state but still
      // prints its JSON result, so a failed exec with output is still an answer.
      if (failure.stdout.trim().length === 0) {
        logger.warn(
          `[NetworkFilterBridge] controller ${command} failed: ${errorMessage(error)}`,
          error,
        );
        return this.unavailable(
          `network-filter-controller ${command} failed: ${errorMessage(error)}`,
        );
      }
      stdout = failure.stdout;
    }
    return this.parse(command, stdout);
  }

  private parse(command: string, stdout: string): NetworkFilterSnapshotResult {
    const line = lastNonEmptyLine(stdout);
    let json: unknown;
    try {
      json = JSON.parse(line ?? "");
    } catch (error) {
      logger.warn(
        `[NetworkFilterBridge] controller ${command} printed non-JSON output: ${errorMessage(error)}`,
        error,
      );
      return this.unavailable(`network-filter-controller ${command} printed no JSON result.`);
    }
    const version = controllerVersionSchema.safeParse(json);
    if (version.success && version.data.version !== NETWORK_FILTER_CONTRACT_VERSION) {
      logger.warn(
        `[NetworkFilterBridge] controller contract version ${version.data.version}, expected ${NETWORK_FILTER_CONTRACT_VERSION}`,
      );
      return {
        state: "unavailable",
        detail:
          `network-filter-controller speaks contract version ${version.data.version}, but this ` +
          `AutoMobile expects version ${NETWORK_FILTER_CONTRACT_VERSION}. Install the matching ` +
          `build with \`${NETWORK_FILTER_INSTALL_COMMAND}\`.`,
        contractVersion: version.data.version,
      };
    }
    const parsed = controllerResultSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn(
        `[NetworkFilterBridge] controller ${command} result did not match the contract: ${parsed.error.message}`,
      );
      return this.unavailable(
        `network-filter-controller ${command} printed a result that does not match contract version ${NETWORK_FILTER_CONTRACT_VERSION}.`,
      );
    }
    return {
      state: parsed.data.state,
      detail: parsed.data.detail,
      contractVersion: parsed.data.version,
      ...(parsed.data.snapshot ? { snapshot: parsed.data.snapshot } : {}),
    };
  }
}

/**
 * The step a caller takes from each state. Approval stays a human step:
 * AutoMobile never approves a system extension on the user's behalf.
 */
export function networkFilterNextStep(state: NetworkFilterState): string {
  switch (state) {
    case "not_installed":
      return (
        `Install the network filter (opt-in, changes the host) with \`${NETWORK_FILTER_INSTALL_COMMAND}\`, ` +
        "then approve it in System Settings."
      );
    case "installation_required":
      return (
        `The installed network filter is not a signed, provisioned build running from /Applications. ` +
        `Reinstall it with \`${NETWORK_FILTER_INSTALL_COMMAND}\`.`
      );
    case "approval_required":
      return (
        "Approve the AutoMobile network filter in System Settings > General > Login Items & " +
        "Extensions > Network Extensions (or restart macOS if installation is pending a restart), " +
        `then run \`${NETWORK_FILTER_INSTALL_COMMAND}\` again.`
      );
    case "unavailable":
      return (
        "The network filter did not answer. Check System Settings > General > Login Items & " +
        `Extensions > Network Extensions, then re-run \`${NETWORK_FILTER_INSTALL_COMMAND}\`.`
      );
    case "ready":
      return "The network filter is ready, but offline/reset is not implemented yet (#10264).";
  }
}
