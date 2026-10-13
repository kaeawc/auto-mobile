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
 * Version 2 shipped per-simulator attribution (#10589): `status`/`snapshot`
 * take `--managed` pairs and the snapshot reports per-flow attribution.
 * Version 3 adds the leased per-app `apply`/`reset`/`renew` commands, the
 * `rule` result and the snapshot's `rules` (#10264). Version 4 adds shaping.
 * Legacy offline commands retry only a definitive unknown-contract-flag rejection.
 */
export const NETWORK_FILTER_CONTRACT_VERSION = 4;
export const NETWORK_FILTER_LEGACY_CONTRACT_VERSION = 3;
export const NETWORK_FILTER_UPGRADE_COMMAND = "auto-mobile --ios-network-filter install --upgrade";

export const NETWORK_FILTER_LEGACY_MEMORY_TTL_MS = 60_000;

export interface ControllerVersionMemory {
  isLegacy(controllerPath: string, nowMs: number): boolean;
  markLegacy(controllerPath: string, nowMs: number): void;
  clear(controllerPath: string): void;
}

/** Shared by production bridges; tests inject a fresh instance. */
export class ExpiringControllerVersionMemory implements ControllerVersionMemory {
  private readonly legacySince = new Map<string, number>();

  isLegacy(controllerPath: string, nowMs: number): boolean {
    const markedAt = this.legacySince.get(controllerPath);
    if (markedAt === undefined) {
      return false;
    }
    if (nowMs - markedAt < NETWORK_FILTER_LEGACY_MEMORY_TTL_MS) {
      return true;
    }
    this.clear(controllerPath);
    return false;
  }

  markLegacy(controllerPath: string, nowMs: number): void {
    this.legacySince.set(controllerPath, nowMs);
  }

  clear(controllerPath: string): void {
    this.legacySince.delete(controllerPath);
  }
}

const defaultControllerVersionMemory = new ExpiringControllerVersionMemory();

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

/** One app on one simulator, as the provider reports a rule's target. */
const ruleTargetSchema = z.object({
  simulator: managedSimulatorSchema,
  bundleId: z.string(),
});

/** An active leased rule (snapshot v3, #10264). */
const legacyRuleStatusSchema = z.object({
  target: ruleTargetSchema,
  owner: z.string(),
  ownerGeneration: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  condition: z.literal("offline"),
  leaseRemainingMilliseconds: z.number().int().nonnegative(),
  droppedFlows: z.number().int().nonnegative(),
});
const shapingComponentSchema = z.enum([
  "latency",
  "downloadBandwidth",
  "uploadBandwidth",
  "packetLoss",
]);
const shapingResolutionSchema = z.object({
  profile: z.object({
    outboundDelayMilliseconds: z.number().int().nonnegative(),
    inboundDelayMilliseconds: z.number().int().nonnegative(),
    outboundBytesPerSecond: z.number().int().positive().optional(),
    inboundBytesPerSecond: z.number().int().positive().optional(),
  }),
  applied: z.array(shapingComponentSchema),
  unapplied: z.array(shapingComponentSchema),
});
export type NetworkFilterShapingResolution = z.infer<typeof shapingResolutionSchema>;
export interface NetworkFilterShapingRequest {
  /** Added round-trip milliseconds; the provider splits them between directions. */
  delayMs: number;
  /** Decimal kilobits per second (1000 bits); zero means unlimited. */
  downloadKbps: number;
  uploadKbps: number;
  packetLossPercent?: number;
}
const networkFilterRuleStatusSchema = z.discriminatedUnion("condition", [
  legacyRuleStatusSchema.extend({ shaping: z.never().optional() }),
  legacyRuleStatusSchema.extend({
    condition: z.literal("shaped"),
    shaping: shapingResolutionSchema,
  }),
]);
export type NetworkFilterRuleStatus = z.infer<typeof networkFilterRuleStatusSchema>;

/** The provider's definitive answer to `apply`, `reset` or `renew`. */
const legacyRuleOutcomeSchema = z.enum([
  "applied",
  "reset",
  "renewed",
  "stale_generation",
  "stale_revision",
  "owned_by_another_session",
  "not_found",
  "invalid_lease",
  "invalid_command",
  "capacity_exceeded",
]);
export const networkFilterRuleOutcomeSchema = z.enum([
  ...legacyRuleOutcomeSchema.options,
  "unsupported_condition",
  "invalid_shaping",
]);
export type NetworkFilterRuleOutcome = z.infer<typeof networkFilterRuleOutcomeSchema>;

const legacyRuleResultSchema = z.object({
  outcome: legacyRuleOutcomeSchema,
  installedRevision: z.number().int().positive().optional(),
  leaseRemainingMilliseconds: z.number().int().nonnegative().optional(),
});
const shapingRejectionSchema = z.object({
  reason: z.enum(["out_of_range", "nothing_to_apply"]),
  component: shapingComponentSchema.optional(),
  unapplied: z.array(shapingComponentSchema).optional(),
});
const networkFilterRuleResultSchema = legacyRuleResultSchema.extend({
  outcome: networkFilterRuleOutcomeSchema,
  shaping: shapingResolutionSchema.optional(),
  rejection: shapingRejectionSchema.optional(),
});
export type NetworkFilterRuleResult = z.infer<typeof networkFilterRuleResultSchema>;

/** Validate the argument domain only; provider-specific limits remain provider decisions. */
export function networkFilterShapingRequestRejection(
  request: NetworkFilterShapingRequest,
): NetworkFilterRuleResult["rejection"] | undefined {
  const integers = [
    ["latency", request.delayMs],
    ["downloadBandwidth", request.downloadKbps],
    ["uploadBandwidth", request.uploadKbps],
  ] as const;
  for (const [component, value] of integers) {
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value))) {
      return { reason: "out_of_range", component };
    }
  }
  const loss = request.packetLossPercent;
  return loss !== undefined && (!Number.isFinite(loss) || loss < 0 || loss > 100)
    ? { reason: "out_of_range", component: "packetLoss" }
    : undefined;
}

/** The rejection component's corresponding request field, for actionable details. */
export function networkFilterShapingRejectionDetail(
  rejection: NonNullable<NetworkFilterRuleResult["rejection"]>,
): string {
  const fields = {
    latency: "delayMs",
    downloadBandwidth: "downloadKbps",
    uploadBandwidth: "uploadKbps",
    packetLoss: "packetLossPercent",
  };
  return `Invalid shaping field ${rejection.component ? fields[rejection.component] : "request"}: outside the numeric argument domain.`;
}

/** The provider's diagnostic snapshot; its own `version` evolves with the provider. */
const legacySnapshotSchema = z.object({
  version: z.number().int(),
  backend: z.string(),
  mode: z.string(),
  observedFlows: z.number().int().nonnegative(),
  discardedFlows: z.number().int().nonnegative(),
  managedSimulators: z.array(managedSimulatorSchema).optional(),
  rules: z.array(legacyRuleStatusSchema).optional(),
  flows: z.array(networkFilterFlowSchema),
  limitations: z.array(z.string()),
});
const counterSchema = z.number().int().nonnegative();
const shapingActivitySchema = z.strictObject({
  flows: z.array(
    z.strictObject({
      target: ruleTargetSchema,
      owner: z.string(),
      ownerGeneration: counterSchema,
      revision: z.number().int().positive(),
      trackedFlows: counterSchema,
      pausedFlows: counterSchema,
      outboundReleasedBytes: counterSchema,
      inboundReleasedBytes: counterSchema,
      outboundHeldBursts: counterSchema,
      inboundHeldBursts: counterSchema,
      overBudgetDrops: counterSchema,
      refusedFlows: counterSchema,
      callbacksWhilePaused: counterSchema,
      debtReleases: counterSchema,
    }),
  ),
  untrackedDataCallbacks: counterSchema,
  pendingPauses: counterSchema,
  filteredFlows: counterSchema,
  completionRecords: counterSchema,
  tickOutstanding: z.boolean(),
  orphanedPauses: counterSchema,
  unexpectedSecondPause: counterSchema,
});
const networkFilterSnapshotSchema = legacySnapshotSchema.extend({
  version: z.literal(NETWORK_FILTER_CONTRACT_VERSION),
  rules: z.array(networkFilterRuleStatusSchema).optional(),
  shapingActivity: shapingActivitySchema.optional().catch((context) => {
    logger.warn(
      "[NetworkFilterBridge] ignoring invalid shapingActivity diagnostics",
      context.error,
    );
    return undefined;
  }),
});
export type NetworkFilterSnapshot = Omit<z.infer<typeof networkFilterSnapshotSchema>, "version"> & {
  version: number;
};

const controllerVersionSchema = z.object({ version: z.number().int() });

const legacyControllerResultSchema = z.object({
  version: z.literal(NETWORK_FILTER_LEGACY_CONTRACT_VERSION),
  state: networkFilterControllerStateSchema,
  detail: z.string(),
  snapshot: legacySnapshotSchema.optional(),
  rule: legacyRuleResultSchema.optional(),
});
const controllerResultSchema = legacyControllerResultSchema.extend({
  version: z.literal(NETWORK_FILTER_CONTRACT_VERSION),
  snapshot: networkFilterSnapshotSchema.optional(),
  rule: networkFilterRuleResultSchema.optional(),
});

export interface NetworkFilterStatus {
  state: NetworkFilterState;
  /** The controller's own detail, or why the bridge could not get an answer. */
  detail: string;
  /** Contract version the controller reported; absent when it gave no valid answer. */
  contractVersion?: number;
  /** `status` only: the leased rules the provider enforces right now. */
  rules?: NetworkFilterRuleStatus[];
}

export interface NetworkFilterSnapshotResult extends NetworkFilterStatus {
  /** Present only when the controller reached the provider (`ready`). */
  snapshot?: NetworkFilterSnapshot;
}

/**
 * The app a rule targets. The bridge supplies the device set, so a target is
 * the simulator UDID plus the app's bundle identifier.
 */
export interface NetworkFilterRuleTarget {
  udid: string;
  bundleId: string;
}

/**
 * Who sends a rule command: the owning session, its binding generation, and
 * a revision that increases with every command the session sends.
 */
export interface NetworkFilterRuleOwnership {
  owner: string;
  ownerGeneration: number;
  revision: number;
}

export interface NetworkFilterRuleCommandResult extends NetworkFilterStatus {
  /** Definitive legacy argument rejection: nothing reached the provider. */
  upgradeRequired?: { installedVersion: number; requiredVersion: number; command: string };
  /**
   * The provider's definitive answer. Absent whenever the outcome is unknown
   * (not installed, timeout, unavailable, malformed output): the command may or
   * may not have reached the provider, and the caller reconciles with `status`.
   */
  rule?: NetworkFilterRuleResult;
}

/**
 * Bridge to the controller. No method throws: every failure (missing binary,
 * timeout, malformed output, contract mismatch) resolves to a typed state.
 */
export interface NetworkFilterBridge {
  status(): Promise<NetworkFilterStatus>;
  snapshot(): Promise<NetworkFilterSnapshotResult>;
  /**
   * Apply offline or shaped configuration for `leaseMs` unless renewed.
   * Callers must validate shaping first; invalid argument domains return unavailable without exec.
   */
  apply(
    target: NetworkFilterRuleTarget,
    ownership: NetworkFilterRuleOwnership,
    leaseMs: number,
    shaping?: NetworkFilterShapingRequest,
  ): Promise<NetworkFilterRuleCommandResult>;
  /** Remove the owner's rule for the target; never clears another owner's rule. */
  reset(
    target: NetworkFilterRuleTarget,
    ownership: NetworkFilterRuleOwnership,
  ): Promise<NetworkFilterRuleCommandResult>;
  /** Extend the lease of the installed revision `ownership.revision`. */
  renew(
    target: NetworkFilterRuleTarget,
    ownership: NetworkFilterRuleOwnership,
    leaseMs: number,
  ): Promise<NetworkFilterRuleCommandResult>;
}

export interface ExecNetworkFilterBridgeOptions {
  executor?: HostCommandExecutor;
  /** The host's booted simulators, passed as `--managed` pairs; defaults to simctl. */
  managedSimulators?: () => Promise<ManagedSimulator[]>;
  /** The active device set; defaults to `CORESIMULATOR_DEVICE_SET_PATH` or the default set. */
  deviceSet?: () => string;
  /** Absolute path to `network-filter-controller`; injectable for tests and local builds. */
  controllerPath?: string;
  exists?: (path: string) => boolean;
  timeoutMs?: number;
  versionMemory?: ControllerVersionMemory;
  now?: () => number;
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

function activeDeviceSet(
  dependencies: Pick<ManagedSimulatorListerDependencies, "environment" | "homeDirectory"> = {},
): string {
  return defaultDeviceSetRoot(
    (dependencies.homeDirectory ?? homedir)(),
    dependencies.environment ?? process.env,
  );
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
    const deviceSet = activeDeviceSet(dependencies);
    const udids = [...new Set(booted.map((device) => device.deviceId))].filter(
      (deviceId) => resolveIosDeviceKind({ deviceId }) === "simulator",
    );
    return udids
      .slice(0, NETWORK_FILTER_MAX_MANAGED_SIMULATORS)
      .map((udid) => ({ deviceSet, udid }));
  };
}

type NetworkFilterRuleCommand = "apply" | "reset" | "renew";
type NetworkFilterControllerCommand = "status" | "snapshot" | NetworkFilterRuleCommand;

function managedArguments(simulators: readonly ManagedSimulator[]): string[] {
  return simulators.flatMap((simulator) => ["--managed", simulator.deviceSet, simulator.udid]);
}

type ControllerAnswer = NetworkFilterSnapshotResult &
  Pick<NetworkFilterRuleCommandResult, "rule" | "upgradeRequired"> & { legacyRejected?: boolean };

/**
 * Runs the installed controller through the host exec seam. Legacy memory is shared by
 * controller path: every bridge notices an upgraded app within the 60-second TTL,
 * immediately on a shaped apply. Callers must validate shaping before applying;
 * an invalid argument domain returns unavailable without running the controller.
 */
export class ExecNetworkFilterBridge implements NetworkFilterBridge {
  private readonly executor: HostCommandExecutor;
  private readonly controllerPath: string;
  private readonly exists: (path: string) => boolean;
  private readonly timeoutMs: number;
  private readonly managedSimulators: () => Promise<ManagedSimulator[]>;
  private readonly deviceSet: () => string;
  private readonly versionMemory: ControllerVersionMemory;
  private readonly now: () => number;

  constructor(options: ExecNetworkFilterBridgeOptions = {}) {
    this.versionMemory = options.versionMemory ?? defaultControllerVersionMemory;
    this.now = options.now ?? Date.now;
    this.executor = options.executor ?? new DefaultHostCommandExecutor();
    this.controllerPath = options.controllerPath ?? DEFAULT_NETWORK_FILTER_CONTROLLER_PATH;
    this.exists = options.exists ?? existsSync;
    this.timeoutMs = options.timeoutMs ?? NETWORK_FILTER_CONTROLLER_TIMEOUT_MS;
    this.managedSimulators = options.managedSimulators ?? createManagedSimulatorLister();
    this.deviceSet = options.deviceSet ?? (() => activeDeviceSet());
  }

  async status(): Promise<NetworkFilterStatus> {
    const result = await this.run("status", async () =>
      managedArguments(await this.managedSimulators()),
    );
    return {
      state: result.state,
      detail: result.detail,
      ...(result.contractVersion !== undefined ? { contractVersion: result.contractVersion } : {}),
      ...(result.snapshot?.rules ? { rules: result.snapshot.rules } : {}),
    };
  }

  snapshot(): Promise<NetworkFilterSnapshotResult> {
    return this.run("snapshot", async () => managedArguments(await this.managedSimulators()));
  }

  apply(
    target: NetworkFilterRuleTarget,
    ownership: NetworkFilterRuleOwnership,
    leaseMs: number,
    shaping?: NetworkFilterShapingRequest,
  ): Promise<NetworkFilterRuleCommandResult> {
    const rejection = shaping && networkFilterShapingRequestRejection(shaping);
    if (rejection) {
      return Promise.resolve(this.unavailable(networkFilterShapingRejectionDetail(rejection)));
    }
    return this.runRule("apply", target, ownership, leaseMs, shaping);
  }

  reset(
    target: NetworkFilterRuleTarget,
    ownership: NetworkFilterRuleOwnership,
  ): Promise<NetworkFilterRuleCommandResult> {
    return this.runRule("reset", target, ownership);
  }

  renew(
    target: NetworkFilterRuleTarget,
    ownership: NetworkFilterRuleOwnership,
    leaseMs: number,
  ): Promise<NetworkFilterRuleCommandResult> {
    return this.runRule("renew", target, ownership, leaseMs);
  }

  private async runRule(
    command: NetworkFilterRuleCommand,
    target: NetworkFilterRuleTarget,
    ownership: NetworkFilterRuleOwnership,
    leaseMs?: number,
    shaping?: NetworkFilterShapingRequest,
  ): Promise<NetworkFilterRuleCommandResult> {
    const result = await this.run(
      command,
      async () => [
        ...managedArguments([{ deviceSet: this.deviceSet(), udid: target.udid }]),
        "--bundle-id",
        target.bundleId,
        "--owner",
        ownership.owner,
        "--owner-generation",
        String(ownership.ownerGeneration),
        "--revision",
        String(ownership.revision),
        ...(leaseMs === undefined ? [] : ["--lease-ms", String(Math.round(leaseMs))]),
        ...(shaping === undefined
          ? []
          : [
              "--delay-ms",
              String(Math.round(shaping.delayMs)),
              "--down-kbps",
              String(Math.round(shaping.downloadKbps)),
              "--up-kbps",
              String(Math.round(shaping.uploadKbps)),
              ...(shaping.packetLossPercent !== undefined && shaping.packetLossPercent > 0
                ? [
                    "--packet-loss-percent",
                    shaping.packetLossPercent.toLocaleString("en-US", {
                      useGrouping: false,
                      maximumSignificantDigits: 21,
                    }),
                  ]
                : []),
            ]),
      ],
      shaping !== undefined,
    );
    const status: NetworkFilterRuleCommandResult = {
      state: result.state,
      detail: result.detail,
      ...(result.contractVersion !== undefined ? { contractVersion: result.contractVersion } : {}),
      ...(result.upgradeRequired ? { upgradeRequired: result.upgradeRequired } : {}),
    };
    // Only a `ready` answer that carries the provider's verdict is definitive.
    return result.state === "ready" && result.rule ? { ...status, rule: result.rule } : status;
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

  private async run(
    command: NetworkFilterControllerCommand,
    commandArguments: () => Promise<string[]>,
    shaped = false,
  ): Promise<ControllerAnswer> {
    try {
      if (!this.exists(this.controllerPath)) {
        return this.notInstalled();
      }
      const args = await commandArguments();
      const version =
        shaped || !this.versionMemory.isLegacy(this.controllerPath, this.now())
          ? NETWORK_FILTER_CONTRACT_VERSION
          : NETWORK_FILTER_LEGACY_CONTRACT_VERSION;
      const answer = await this.invoke(command, args, version);
      if (!answer.legacyRejected) {
        return answer;
      }
      this.versionMemory.markLegacy(this.controllerPath, this.now());
      if (!shaped) {
        return this.invoke(command, args, NETWORK_FILTER_LEGACY_CONTRACT_VERSION);
      }
      return {
        state: "unavailable",
        contractVersion: NETWORK_FILTER_LEGACY_CONTRACT_VERSION,
        detail: `The installed network-filter-controller speaks version 3; shaped rules require version 4. Update it with \`${NETWORK_FILTER_UPGRADE_COMMAND}\`.`,
        upgradeRequired: {
          installedVersion: NETWORK_FILTER_LEGACY_CONTRACT_VERSION,
          requiredVersion: NETWORK_FILTER_CONTRACT_VERSION,
          command: NETWORK_FILTER_UPGRADE_COMMAND,
        },
      };
    } catch (error) {
      throwIfRequestAborted();
      logger.warn(
        `[NetworkFilterBridge] preparing ${command} failed: ${errorMessage(error)}`,
        error,
      );
      return this.unavailable(
        `network-filter-controller ${command} failed: ${errorMessage(error)}`,
      );
    }
  }

  private async invoke(
    command: NetworkFilterControllerCommand,
    args: string[],
    version: number,
  ): Promise<ControllerAnswer> {
    let stdout: string;
    try {
      const result = await this.executor.executeCommand(
        this.controllerPath,
        [
          command,
          ...(version === NETWORK_FILTER_CONTRACT_VERSION ? ["--contract-version", "4"] : []),
          ...args,
        ],
        {
          timeoutMs: this.timeoutMs,
          maxBuffer: CONTROLLER_MAX_BUFFER_BYTES,
          signal: combineWithAmbientAbort(),
        },
      );
      stdout = result.stdout;
    } catch (error) {
      throwIfRequestAborted();
      const failure = execFailureDetails(error);
      if (failure.code === "ENOENT") {
        return this.notInstalled();
      }
      // Non-ready controllers exit non-zero but still print their typed answer.
      if (failure.stdout.trim().length === 0) {
        logger.warn(
          `[NetworkFilterBridge] controller ${command} failed: ${errorMessage(error)}`,
          error,
        );
        return this.unavailable(
          `network-filter-controller ${command} failed: ${errorMessage(error)}`,
        );
      }
      // Non-ready states and legacy flag rejection are expected exits with a typed answer.
      logger.debug(
        `[NetworkFilterBridge] controller ${command} exited with output: ${errorMessage(error)}`,
      );
      stdout = failure.stdout;
    }
    return this.parse(command, stdout, version);
  }

  private mismatch(version: number): ControllerAnswer {
    logger.warn(
      `[NetworkFilterBridge] controller contract version ${version}, expected versions 3 and 4`,
    );
    return {
      state: "unavailable",
      detail: `network-filter-controller speaks contract version ${version}, but this AutoMobile expects versions 3 and 4 with the requested version honoured. Install the matching build with \`${NETWORK_FILTER_INSTALL_COMMAND}\`.`,
      contractVersion: version,
    };
  }

  private parse(command: string, stdout: string, requestedVersion: number): ControllerAnswer {
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const controllerLines: Array<{ json: unknown; version: number }> = [];
    for (const line of lines) {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch (error) {
        // Controller results are JSON objects with a version; other output is diagnostic noise.
        logger.debug(`[NetworkFilterBridge] controller diagnostic: ${line}`, error);
        continue;
      }
      const version = z.object({ version: z.number() }).safeParse(json);
      if (!version.success) {
        logger.debug(`[NetworkFilterBridge] controller diagnostic: ${line}`);
        continue;
      }
      controllerLines.push({ json, version: version.data.version });
    }
    const last = controllerLines.at(-1);
    if (!last) {
      return this.unavailable(`network-filter-controller ${command} printed no JSON result.`);
    }
    const different = controllerLines.find((line) => line.version !== last.version);
    if (different) {
      return this.mismatch(different.version);
    }
    let answer: ControllerAnswer | undefined;
    for (const line of controllerLines) {
      answer = this.parseLine(command, line.json, requestedVersion);
      if (!answer) {
        return this.unavailable(
          `network-filter-controller ${command} printed a result that does not match contract version ${requestedVersion}.`,
        );
      }
      if (answer.legacyRejected && controllerLines.length !== 1) {
        return this.mismatch(NETWORK_FILTER_LEGACY_CONTRACT_VERSION);
      }
    }
    return (
      answer ?? this.unavailable(`network-filter-controller ${command} printed no JSON result.`)
    );
  }

  private parseLine(
    command: string,
    json: unknown,
    requestedVersion: number,
  ): ControllerAnswer | undefined {
    const version = controllerVersionSchema.safeParse(json);
    if (!version.success) {
      logger.warn(
        `[NetworkFilterBridge] controller ${command} result has no valid contract version`,
        version.error,
      );
      return undefined;
    }
    if (
      ![NETWORK_FILTER_LEGACY_CONTRACT_VERSION, NETWORK_FILTER_CONTRACT_VERSION].includes(
        version.data.version,
      )
    ) {
      return this.mismatch(version.data.version);
    }
    const schema =
      version.data.version === NETWORK_FILTER_LEGACY_CONTRACT_VERSION
        ? legacyControllerResultSchema
        : controllerResultSchema;
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      logger.warn(
        `[NetworkFilterBridge] controller ${command} result failed schema validation`,
        parsed.error,
      );
      return version.data.version !== requestedVersion
        ? this.mismatch(version.data.version)
        : undefined;
    }
    return this.controllerAnswer(parsed.data, requestedVersion);
  }

  private controllerAnswer(
    data: z.infer<typeof legacyControllerResultSchema> | z.infer<typeof controllerResultSchema>,
    requestedVersion: number,
  ): ControllerAnswer {
    const legacyRejected =
      requestedVersion === NETWORK_FILTER_CONTRACT_VERSION && this.isLegacyRejection(data);
    if (data.version === NETWORK_FILTER_CONTRACT_VERSION) {
      this.versionMemory.clear(this.controllerPath);
    } else if (requestedVersion === NETWORK_FILTER_CONTRACT_VERSION && !legacyRejected) {
      return this.mismatch(data.version);
    }
    return {
      state: data.state,
      detail: data.detail,
      contractVersion: data.version,
      ...(data.snapshot ? { snapshot: data.snapshot } : {}),
      ...(data.state === "ready" && data.rule ? { rule: data.rule } : {}),
      ...(legacyRejected ? { legacyRejected: true } : {}),
    };
  }

  private isLegacyRejection(data: {
    version: number;
    state: NetworkFilterControllerState;
    detail: string;
  }): boolean {
    return (
      data.version === NETWORK_FILTER_LEGACY_CONTRACT_VERSION &&
      data.state === "unavailable" &&
      data.detail.startsWith("Unexpected argument '--contract-version'")
    );
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
      return (
        "The network filter is ready. Pass networkCondition.appId with profile `offline` or `none` " +
        "to take one app on this simulator offline or restore it, within a session."
      );
  }
}
