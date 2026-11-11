import { DaemonClient, DaemonUnavailableError } from "../client/client";
import type { DaemonManagerLike, DaemonRestartResult } from "../manager";
import type { DaemonOptions, DaemonStatus } from "../types";
import type { Timer } from "../../utils/SystemTimer";
import type { DaemonMcpProxyConfig } from "../daemonMcpProxy";
import {
  assertDaemonNamespaceMatchesState,
  isDaemonNamespaceIsolated,
} from "../sharedNamespaceGuard";
import { logger } from "../../utils/logger";
import {
  DAEMON_STARTUP_TIMEOUT_MS,
  resolveDaemonVersion,
  syncSettledDaemonVersion,
  DAEMON_RESTART_HANDOFF_DELAY_MS,
  DAEMON_VERSION_RESTART_COOLDOWN_MS,
  DEFAULT_DAEMON_PORT,
} from "../wire/constants";
import {
  buildIdentitiesMatch,
  buildIdentityFromStatus,
  type BuildIdentity,
} from "../wire/buildIdentity";
import { compareStrictNumericVersions } from "../../utils/deviceMatcher";
import { releaseVersion, withoutDirtyStamp } from "../../utils/mcpVersion";
import { daemonProcessOptions } from "../daemonOptionScopes";
import { DaemonRestartDeferredError } from "../daemonRestartAdmission";
import {
  startupOptionDeficits,
  mergeDaemonOptions,
  restartOptionsForLostDaemon,
} from "./startupOptions";
import { DaemonRestartOptionsUnknownError } from "./DaemonRestartOptionsUnknownError";
import {
  DaemonVersionMismatchError,
  type VersionMismatchReason,
} from "./DaemonVersionMismatchError";
import { DaemonBuildMismatchError, type BuildMismatchReason } from "./DaemonBuildMismatchError";
import { DaemonAssetVersionMismatchError } from "./DaemonAssetVersionMismatchError";
import { DaemonPreflightConnectionError } from "./DaemonPreflightConnectionError";
export async function runPreflightTransport<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DaemonUnavailableError) {
      throw new DaemonPreflightConnectionError(error);
    }
    throw error;
  }
}

function startupOptionRecoveryGuidance(): string {
  return (
    "Close and relaunch this configured MCP client once so it owns the next bounded " +
    "reconciliation attempt; do not delete daemon control files manually."
  );
}

/** Live proxy state and callbacks used by startup reconciliation. */
export interface DaemonLifecycleReconcilerDeps {
  readonly config: {
    autoStartDaemon?: boolean;
    socketPath?: string;
    connectionTimeoutMs?: number;
    daemonOptions?: DaemonOptions;
    lifecycleNamespaceEnv?: NodeJS.ProcessEnv;
  };
  readonly daemonManager: Pick<
    DaemonManagerLike,
    "status" | "restart" | "start" | "waitForReady" | "waitForLockHolderReadiness"
  >;
  readonly daemonStatusProbe: (() => Promise<DaemonStatus>) | undefined;
  reconciliationSnapshot: Promise<DaemonStatus> | undefined;
  readonly timer: Timer;
  readonly clientVersion: string;
  readonly clientAssetVersion: string | null;
  readonly buildIdentity: BuildIdentity;
  /** Version a daemon spawned from this client's entry script would report now; undefined when it cannot be probed. */
  readonly readCheckoutVersion?: () => Promise<string | null>;
  invalidateCache(): void;
  assertDaemonLifecycleUnfenced(): void;

  reconciliationStatus(): Promise<DaemonStatus>;
  isSameDaemonGeneration(current: DaemonStatus, expected: DaemonStatus): boolean;
  waitForJoinedRestartSuccessor(expected: DaemonStatus, deadline: number): Promise<DaemonStatus>;
  waitForRunningReconciliationStatus(deadline: number): Promise<DaemonStatus>;
  readSocketReconciliationStatus(): Promise<DaemonStatus>;
  assertAutomaticRestartAllowed(status: DaemonStatus, reason: string): void;
  ensureVersionMatches(
    reconciliationDeadline?: number,
    observedStatus?: DaemonStatus,
  ): Promise<void>;
  verifyRestartedVersion(): Promise<void>;
  requiresVersionRestart(status: DaemonStatus, runningVersion: string): boolean;
  assertNewerClientVersion(
    status: DaemonStatus,
    runningVersion: string,
    runningBase: string,
    options: { clientBase: string; sameRelease: boolean },
  ): void;
  assertVersionRestartCooldownExpired(status: DaemonStatus, runningVersion: string): void;
  versionMismatchError(
    runningVersion: string,
    reason: VersionMismatchReason,
    detail: string,
    options?: { retryAfterMs?: number; daemonBuild?: BuildIdentity },
  ): DaemonVersionMismatchError;

  ensureBuildMatches(reconciliationDeadline?: number, observedStatus?: DaemonStatus): Promise<void>;
  finishBuildRestart(
    restartResult: DaemonRestartResult,
    status: DaemonStatus,
    reconciliationDeadline: number,
  ): Promise<void>;
  buildMismatchError(
    daemon: BuildIdentity,
    reason: BuildMismatchReason,
    detail: string,
    retryAfterMs?: number,
  ): DaemonBuildMismatchError;
}

export class DaemonLifecycleReconciler {
  private lastRunningStatus: DaemonStatus | undefined;
  private checkoutVersion: string | undefined;
  private readonly acceptedCheckoutVersions = new Set<string>();

  constructor(private readonly deps: DaemonLifecycleReconcilerDeps) {}

  private observeStatus(status: DaemonStatus): DaemonStatus {
    if (status.running) {
      this.lastRunningStatus = {
        ...status,
        options: status.options ? { ...status.options } : undefined,
      };
    }
    return status;
  }

  createStatusProbe(config: DaemonMcpProxyConfig): (() => Promise<DaemonStatus>) | undefined {
    // Custom transports supply their matching probe separately; constructing a
    // default socket client here would escape an injected transport/test seam.
    if (config.daemonStatusProbe) {
      return config.daemonStatusProbe;
    }
    if (config.clientFactory) {
      return undefined;
    }
    return () =>
      new DaemonClient(
        this.deps.config.socketPath,
        this.deps.config.connectionTimeoutMs,
      ).getDaemonStatus();
  }

  reconciliationStatus(): Promise<DaemonStatus> {
    const status = this.deps.daemonStatusProbe
      ? (this.deps.reconciliationSnapshot ??= this.deps.readSocketReconciliationStatus())
      : this.deps.daemonManager.status();
    // Observe before consumers resume, preserving the original promise's reconciliation timing.
    // Its rejection still propagates through the returned promise to the caller.
    void status.then(
      (observed) => this.observeStatus(observed),
      () => undefined,
    );
    return status;
  }

  isSameDaemonGeneration(current: DaemonStatus, expected: DaemonStatus): boolean {
    if (!current.running || !expected.running || current.pid !== expected.pid) {
      return false;
    }
    const identityFields = ["startedAt", "version", "buildId", "entryScript"] as const;
    return identityFields.every(
      (field) => expected[field] === undefined || current[field] === expected[field],
    );
  }

  /**
   * A competing client can observe the incumbent during an admitted restart's
   * intentional handoff gap. Wait for a different, running generation instead
   * of treating that gap as a completed reconciliation.
   */
  async waitForJoinedRestartSuccessor(
    expected: DaemonStatus,
    deadline: number,
  ): Promise<DaemonStatus> {
    let initialProbe = true;
    while (initialProbe || this.deps.timer.now() < deadline) {
      initialProbe = false;
      try {
        const status = await this.deps.reconciliationStatus();
        if (status.running && !this.deps.isSameDaemonGeneration(status, expected)) {
          return status;
        }
      } catch (error) {
        if (!(error instanceof DaemonPreflightConnectionError)) {
          throw error;
        }
        // A missing socket is expected while the restart owner changes generations.
        logger.debug(`[DaemonMcpProxy] Waiting for joined restart successor: ${error.message}`);
      }
      this.deps.reconciliationSnapshot = undefined;
      const remaining = deadline - this.deps.timer.now();
      if (remaining <= 0) {
        break;
      }
      await this.deps.timer.sleep(Math.min(DAEMON_RESTART_HANDOFF_DELAY_MS, remaining));
      this.deps.reconciliationSnapshot = undefined;
    }
    throw new DaemonUnavailableError(
      `Timed out waiting for concurrent daemon restart after ${DAEMON_STARTUP_TIMEOUT_MS}ms`,
    );
  }

  async waitForRunningReconciliationStatus(deadline: number): Promise<DaemonStatus> {
    let initialProbe = true;
    while (initialProbe || this.deps.timer.now() < deadline) {
      initialProbe = false;
      try {
        const status = await this.deps.reconciliationStatus();
        if (status.running) {
          return status;
        }
      } catch (error) {
        if (!(error instanceof DaemonPreflightConnectionError)) {
          throw error;
        }
        // A follow-up reconciler may temporarily remove the incumbent socket.
        logger.debug(`[DaemonMcpProxy] Waiting through restart handoff: ${error.message}`);
      }
      this.deps.reconciliationSnapshot = undefined;
      const remaining = deadline - this.deps.timer.now();
      if (remaining <= 0) {
        break;
      }
      await this.deps.timer.sleep(Math.min(DAEMON_RESTART_HANDOFF_DELAY_MS, remaining));
      this.deps.reconciliationSnapshot = undefined;
    }
    throw new DaemonUnavailableError(
      `Timed out waiting for daemon reconciliation after ${DAEMON_STARTUP_TIMEOUT_MS}ms`,
    );
  }

  async readSocketReconciliationStatus(): Promise<DaemonStatus> {
    const recorded = await this.deps.daemonManager.status();
    const actual = await runPreflightTransport(() => this.deps.daemonStatusProbe!());
    // Compatibility allows legacy missing build fields, but missing identity is not
    // evidence that a PID record belongs to this socket. Only enrich a known matching
    // process, build and entry script; never manufacture live build/options from a legacy probe.
    const actualBuild = buildIdentityFromStatus(actual);
    const matchesRecord =
      recorded.running &&
      actual.pid !== undefined &&
      actual.pid === recorded.pid &&
      recorded.version === actual.version &&
      actualBuild.buildId !== "unknown" &&
      actualBuild.buildId.length > 0 &&
      actualBuild.entryScript.length > 0 &&
      recorded.buildId === actualBuild.buildId &&
      recorded.entryScript === actualBuild.entryScript;
    // Only the socket owner can advertise support, even when PID metadata matches.
    return this.observeStatus(
      matchesRecord
        ? {
            ...recorded,
            ...actual,
            structuredSessionNotFound: actual.structuredSessionNotFound,
            structuredToolErrorCodes: actual.structuredToolErrorCodes,
          }
        : actual,
    );
  }

  assertAutomaticRestartAllowed(status: DaemonStatus, reason: string): void {
    this.deps.assertDaemonLifecycleUnfenced();
    if (this.deps.config.lifecycleNamespaceEnv) {
      // A private state env with the shared namespace would restart the resident daemon (#11252).
      assertDaemonNamespaceMatchesState(
        `restart the daemon (${reason})`,
        this.deps.config.lifecycleNamespaceEnv,
      );
    }
    if (status.activeProvisioning) {
      throw new DaemonRestartDeferredError(reason);
    }
  }

  /** Newer clients may replace older daemons; mismatches remain a pre-dispatch gate. */
  ensureVersionMatches(
    reconciliationDeadline = this.deps.timer.now() + DAEMON_STARTUP_TIMEOUT_MS,
    observedStatus?: DaemonStatus,
  ): Promise<void> {
    // Compare the settled (dirty-aware) identity (#14405). Once settled, call through
    // directly so the gate adds no microtask turns ahead of the status read.
    if (syncSettledDaemonVersion()) {
      return this.ensureSettledVersionMatches(reconciliationDeadline, observedStatus);
    }
    return resolveDaemonVersion().then(() =>
      this.ensureSettledVersionMatches(reconciliationDeadline, observedStatus),
    );
  }

  private async ensureSettledVersionMatches(
    reconciliationDeadline: number,
    observedStatus: DaemonStatus | undefined,
  ): Promise<void> {
    const status = this.observeStatus(observedStatus ?? (await this.deps.reconciliationStatus()));
    if (!status.running) {
      return;
    }

    const runningVersion = status.version?.trim() ?? "";
    if (runningVersion === this.deps.clientVersion) {
      return;
    }

    if (!this.deps.requiresVersionRestart(status, runningVersion)) {
      return;
    }

    if ((await this.staleClientDisposition(status, runningVersion)) === "accept") {
      return;
    }

    // Reach here when the client is strictly newer OR the daemon is a same-release
    // dev-skew (different git stamp). Both reconcile by restarting the daemon from
    // this client's build. Same-release dev-skew must be handled HERE rather than
    // deferred to ensureBuildMatches: the build-identity hash covers only the entry
    // script (process.argv[1]), so in unbundled source-mode runs (`bun src/index.ts`)
    // it is blind to commits that change non-entry files — the git stamp is the only
    // signal. The restart is cooldown-bounded below so two checkouts cannot thrash.

    this.deps.assertVersionRestartCooldownExpired(status, runningVersion);

    if (this.deps.timer.now() >= reconciliationDeadline) {
      throw new DaemonUnavailableError(
        `Timed out waiting for concurrent daemon restart after ${DAEMON_STARTUP_TIMEOUT_MS}ms`,
      );
    }

    logger.info(
      `[DaemonMcpProxy] Daemon version ${runningVersion || "unknown"} differs from MCP server ${this.deps.clientVersion}, restarting daemon`,
    );
    this.deps.assertAutomaticRestartAllowed(status, "version mismatch");
    // Preserve the running daemon's existing options across the restart rather
    // than resetting to this client's config, which would strip flags the
    // daemon was launched with when the connecting client is bare (issue #3846).
    const restartResult = await this.deps.daemonManager.restart(
      mergeDaemonOptions(status.options, this.deps.config.daemonOptions),
      status,
    );
    this.deps.reconciliationSnapshot = undefined;
    if (restartResult === "joined") {
      const successorStatus = await this.deps.waitForJoinedRestartSuccessor(
        status,
        reconciliationDeadline,
      );
      return await this.deps.ensureVersionMatches(reconciliationDeadline, successorStatus);
    }
    // The replacement daemon may expose a different tool set; drop the cache so we
    // never advertise the old daemon's tools against the new build.
    this.deps.invalidateCache();
    const ready = await this.deps.daemonManager.waitForReady(DAEMON_STARTUP_TIMEOUT_MS);
    if (!ready) {
      throw new DaemonUnavailableError(
        `Daemon failed to restart within ${DAEMON_STARTUP_TIMEOUT_MS}ms`,
      );
    }

    await this.deps.verifyRestartedVersion();
  }

  async verifyRestartedVersion(): Promise<void> {
    const restartedStatus = await this.deps.reconciliationStatus();
    const restartedVersion = restartedStatus.version?.trim() ?? "";
    if (
      restartedStatus.running &&
      restartedVersion !== this.deps.clientVersion &&
      this.isClientCheckout(restartedStatus)
    ) {
      this.acceptCheckoutVersion(restartedStatus, restartedVersion);
      return;
    }
    if (!restartedStatus.running || restartedVersion !== this.deps.clientVersion) {
      throw this.deps.versionMismatchError(
        restartedVersion,
        "restartMismatch",
        "daemon restart completed but version still differs",
        { daemonBuild: buildIdentityFromStatus(restartedStatus) },
      );
    }
  }

  private isClientCheckout(status: DaemonStatus): boolean {
    return (
      !!status.entryScript &&
      status.entryScript === this.deps.buildIdentity.entryScript &&
      buildIdentitiesMatch(this.deps.buildIdentity, buildIdentityFromStatus(status))
    );
  }

  private async staleClientDisposition(
    status: DaemonStatus,
    runningVersion: string,
  ): Promise<"accept" | "restart"> {
    if (!this.isClientCheckout(status)) {
      return "restart";
    }
    const checkoutVersion =
      runningVersion === this.checkoutVersion
        ? this.checkoutVersion
        : await this.probeCheckoutVersion();
    if (checkoutVersion !== runningVersion) {
      return "restart";
    }
    this.acceptCheckoutVersion(status, runningVersion);
    return "accept";
  }

  private async probeCheckoutVersion(): Promise<string | undefined> {
    try {
      return (await this.deps.readCheckoutVersion?.()) ?? this.checkoutVersion;
    } catch (error) {
      logger.warn(
        "[DaemonMcpProxy] Checkout version probe failed; using last known version",
        error,
      );
      return this.checkoutVersion;
    }
  }

  private acceptCheckoutVersion(status: DaemonStatus, runningVersion: string): void {
    this.checkoutVersion = runningVersion;
    if (withoutDirtyStamp(runningVersion) !== withoutDirtyStamp(this.deps.clientVersion)) {
      throw this.deps.versionMismatchError(
        runningVersion,
        "staleClient",
        "the daemon already runs this checkout's current version; restarting cannot reconcile",
        { daemonBuild: buildIdentityFromStatus(status) },
      );
    }
    if (!this.acceptedCheckoutVersions.has(runningVersion)) {
      this.acceptedCheckoutVersions.add(runningVersion);
      logger.info(
        `[DaemonMcpProxy] Accepting checkout version ${runningVersion} for MCP client ${this.deps.clientVersion}; only working-tree state differs`,
      );
    }
  }

  requiresVersionRestart(status: DaemonStatus, runningVersion: string): boolean {
    // The release portions (before the `+g<sha>` dev stamp) drive the
    // newer/older decision. A plain release client intentionally matches a
    // source-stamped daemon at that release; two stamped versions still detect
    // source-checkout dev-skew.
    const runningBase = releaseVersion(runningVersion);
    const clientBase = releaseVersion(this.deps.clientVersion);
    const sameRelease = runningBase === clientBase;
    const clientDeclaresFullVersion = clientBase !== this.deps.clientVersion;

    if (sameRelease && !clientDeclaresFullVersion) {
      return false;
    }

    if (!this.deps.config.autoStartDaemon) {
      throw this.deps.versionMismatchError(
        runningVersion,
        "autoStartDisabled",
        "auto-start is disabled",
        { daemonBuild: buildIdentityFromStatus(status) },
      );
    }

    this.deps.assertNewerClientVersion(status, runningVersion, runningBase, {
      clientBase,
      sameRelease,
    });
    return true;
  }

  assertNewerClientVersion(
    status: DaemonStatus,
    runningVersion: string,
    runningBase: string,
    { clientBase, sameRelease }: { clientBase: string; sameRelease: boolean },
  ): void {
    if (!sameRelease) {
      const cmp =
        runningBase.length > 0
          ? compareStrictNumericVersions(clientBase, runningBase)
          : Number.POSITIVE_INFINITY;

      if (runningBase.length > 0 && !Number.isFinite(cmp)) {
        throw this.deps.versionMismatchError(
          runningVersion,
          "nonNumeric",
          "version comparison is not numeric",
          { daemonBuild: buildIdentityFromStatus(status) },
        );
      }

      if (cmp <= 0) {
        throw this.deps.versionMismatchError(
          runningVersion,
          "daemonNewer",
          "the running daemon is newer than this client",
          { daemonBuild: buildIdentityFromStatus(status) },
        );
      }
    }
  }

  assertVersionRestartCooldownExpired(status: DaemonStatus, runningVersion: string): void {
    if (status.startedAt) {
      const daemonAgeMs = this.deps.timer.now() - status.startedAt;
      if (daemonAgeMs < DAEMON_VERSION_RESTART_COOLDOWN_MS) {
        logger.warn(
          `[DaemonMcpProxy] Skipping version-mismatch restart due to cooldown: daemon ${runningVersion || "unknown"} is ${daemonAgeMs}ms old, client version is ${this.deps.clientVersion}`,
        );
        throw this.deps.versionMismatchError(runningVersion, "cooldown", "restart is in cooldown", {
          retryAfterMs: DAEMON_VERSION_RESTART_COOLDOWN_MS - daemonAgeMs,
          daemonBuild: buildIdentityFromStatus(status),
        });
      }
    }
  }

  versionMismatchError(
    runningVersion: string,
    reason: VersionMismatchReason,
    detail: string,
    { retryAfterMs, daemonBuild }: { retryAfterMs?: number; daemonBuild?: BuildIdentity } = {},
  ): DaemonVersionMismatchError {
    const daemonVersion = runningVersion.length > 0 ? runningVersion : "unknown";
    const clientVersion = this.deps.clientVersion.trim();
    return new DaemonVersionMismatchError({
      clientVersion,
      daemonVersion,
      reason,
      detail,
      retryAfterMs,
      clientBuild: this.deps.buildIdentity,
      daemonBuild,
    });
  }

  async ensureAssetVersionPinMatches(): Promise<void> {
    if (!this.deps.clientAssetVersion) {
      return;
    }
    const status = await this.deps.reconciliationStatus();
    if (!status.running) {
      return;
    }
    const daemonAssetVersion = status.assetVersion?.trim() ?? "";
    if (daemonAssetVersion === this.deps.clientAssetVersion) {
      return;
    }
    throw new DaemonAssetVersionMismatchError(
      this.deps.clientAssetVersion,
      daemonAssetVersion.length > 0 ? daemonAssetVersion : "unknown",
    );
  }

  /**
   * Ensure the client never attaches to a daemon built from a *different* checkout.
   * The version string alone cannot detect this (two checkouts can both report the
   * same pre-release version), so we compare a content hash of the entry script.
   * On mismatch, restart the daemon from this client's own entrypoint so the live
   * frontend and backend run the same code. Independent of, and complementary to,
   * {@link ensureVersionMatches}.
   */
  async ensureBuildMatches(
    reconciliationDeadline = this.deps.timer.now() + DAEMON_STARTUP_TIMEOUT_MS,
    observedStatus?: DaemonStatus,
  ): Promise<void> {
    const status = this.observeStatus(observedStatus ?? (await this.deps.reconciliationStatus()));
    if (!status.running) {
      return;
    }

    const daemonIdentity = buildIdentityFromStatus(status);
    if (buildIdentitiesMatch(this.deps.buildIdentity, daemonIdentity)) {
      return;
    }

    if (!this.deps.config.autoStartDaemon) {
      throw this.deps.buildMismatchError(
        daemonIdentity,
        "autoStartDisabled",
        "auto-start is disabled",
      );
    }

    if (status.startedAt) {
      const daemonAgeMs = this.deps.timer.now() - status.startedAt;
      if (daemonAgeMs < DAEMON_VERSION_RESTART_COOLDOWN_MS) {
        logger.warn(
          `[DaemonMcpProxy] Skipping build-mismatch restart due to cooldown: daemon build ${daemonIdentity.buildId} is ${daemonAgeMs}ms old, client build is ${this.deps.buildIdentity.buildId}`,
        );
        throw this.deps.buildMismatchError(
          daemonIdentity,
          "cooldown",
          "restart is in cooldown",
          DAEMON_VERSION_RESTART_COOLDOWN_MS - daemonAgeMs,
        );
      }
    }

    if (this.deps.timer.now() >= reconciliationDeadline) {
      throw new DaemonUnavailableError(
        `Timed out waiting for concurrent daemon restart after ${DAEMON_STARTUP_TIMEOUT_MS}ms`,
      );
    }

    logger.info(
      `[DaemonMcpProxy] Daemon build ${daemonIdentity.buildId} (${daemonIdentity.entryScript || "unknown"}) differs from client build ${this.deps.buildIdentity.buildId} (${this.deps.buildIdentity.entryScript || "unknown"}), restarting daemon`,
    );
    this.deps.assertAutomaticRestartAllowed(status, "build mismatch");
    // Preserve the running daemon's existing options across the restart rather
    // than resetting to this client's config, which would strip flags the
    // daemon was launched with when the connecting client is bare (issue #3846).
    const restartResult = await this.deps.daemonManager.restart(
      mergeDaemonOptions(status.options, this.deps.config.daemonOptions),
      status,
    );
    this.deps.reconciliationSnapshot = undefined;
    return await this.deps.finishBuildRestart(restartResult, status, reconciliationDeadline);
  }

  async finishBuildRestart(
    restartResult: DaemonRestartResult,
    status: DaemonStatus,
    reconciliationDeadline: number,
  ): Promise<void> {
    if (restartResult === "joined") {
      const successorStatus = await this.deps.waitForJoinedRestartSuccessor(
        status,
        reconciliationDeadline,
      );
      return await this.deps.ensureBuildMatches(reconciliationDeadline, successorStatus);
    }
    // The replacement daemon may expose a different tool set; drop the cache so we
    // never advertise the old daemon's tools against the new build.
    this.deps.invalidateCache();
    const ready = await this.deps.daemonManager.waitForReady(DAEMON_STARTUP_TIMEOUT_MS);
    if (!ready) {
      throw new DaemonUnavailableError(
        `Daemon failed to restart within ${DAEMON_STARTUP_TIMEOUT_MS}ms`,
      );
    }

    const restartedStatus = await this.deps.reconciliationStatus();
    const restartedIdentity = buildIdentityFromStatus(restartedStatus);
    if (
      !restartedStatus.running ||
      !buildIdentitiesMatch(this.deps.buildIdentity, restartedIdentity)
    ) {
      throw this.deps.buildMismatchError(
        restartedIdentity,
        "restartMismatch",
        "daemon restart completed but build still differs",
      );
    }
  }

  buildMismatchError(
    daemon: BuildIdentity,
    reason: BuildMismatchReason,
    detail: string,
    retryAfterMs?: number,
  ): DaemonBuildMismatchError {
    return new DaemonBuildMismatchError({
      client: this.deps.buildIdentity,
      daemon,
      reason,
      detail,
      retryAfterMs,
    });
  }

  async ensureStartupOptionsMatch(): Promise<void> {
    const requested = this.deps.config.daemonOptions;
    const reconciliationDeadline = this.deps.timer.now() + DAEMON_STARTUP_TIMEOUT_MS;
    while (this.deps.timer.now() < reconciliationDeadline) {
      const status = await this.deps.reconciliationStatus();
      if (!status.running) {
        return;
      }

      const deficits = startupOptionDeficits(requested, status.options);
      if (deficits.length === 0) {
        return;
      }

      if (!this.deps.config.autoStartDaemon) {
        throw new DaemonUnavailableError(
          `Daemon startup options differ from MCP server options (${deficits.join(", ")}) and auto-start is disabled`,
        );
      }

      logger.info(
        `[DaemonMcpProxy] Daemon startup options differ (${deficits.join(", ")}), restarting daemon`,
      );
      this.deps.assertAutomaticRestartAllowed(status, "startup option mismatch");
      // Preserve the running daemon's existing options and add the requested ones
      // so the restart gains the missing flag without stripping any the daemon
      // already had (issue #3846).
      const restartResult = await this.deps.daemonManager.restart(
        mergeDaemonOptions(status.options, requested),
        status,
      );
      this.deps.reconciliationSnapshot = undefined;
      if (restartResult === "joined") {
        const successorStatus = await this.deps.waitForJoinedRestartSuccessor(
          status,
          reconciliationDeadline,
        );
        const remaining = startupOptionDeficits(requested, successorStatus.options);
        if (remaining.length === 0) {
          return;
        }
        if (this.deps.timer.now() >= reconciliationDeadline) {
          break;
        }
        continue;
      }

      const readinessTimeout = Math.max(0, reconciliationDeadline - this.deps.timer.now());
      await this.deps.daemonManager.waitForReady(readinessTimeout);

      const restartedStatus =
        await this.deps.waitForRunningReconciliationStatus(reconciliationDeadline);
      const remaining = startupOptionDeficits(requested, restartedStatus.options);
      if (remaining.length > 0) {
        throw new DaemonUnavailableError(
          `Daemon process handoff completed (pid ${status.pid ?? "unknown"} -> pid ${restartedStatus.pid ?? "unknown"}), ` +
            `but the successor for the shared per-user daemon still does not satisfy the requested startup options ` +
            `(${remaining.join(", ")}). A different owner or launch path may control the replacement configuration. ` +
            startupOptionRecoveryGuidance(),
        );
      }
      return;
    }
    throw new DaemonUnavailableError(
      `Timed out waiting for concurrent daemon startup-option reconciliation after ${DAEMON_STARTUP_TIMEOUT_MS}ms`,
    );
  }

  /** Choose recovery options only after a previously observed daemon has disappeared. */
  private daemonStartOptions(): DaemonOptions {
    const observed = this.lastRunningStatus;
    const requested = this.deps.config.daemonOptions;
    if (!observed) {
      return daemonProcessOptions(requested);
    }
    const env = this.deps.config.lifecycleNamespaceEnv;
    if (!observed.options && observed.port === undefined && env && isDaemonNamespaceIsolated(env)) {
      throw new DaemonRestartOptionsUnknownError();
    }
    const options = restartOptionsForLostDaemon(observed, requested);
    logger.info(
      `[DaemonMcpProxy] Restarting lost daemon with its recorded startup options ` +
        `(port ${options.port ?? DEFAULT_DAEMON_PORT}, flags ${JSON.stringify(options)})`,
    );
    return options;
  }

  /** Start the daemon process or join an in-progress startup. */
  async startDaemon(): Promise<void> {
    const status = this.observeStatus(await this.deps.daemonManager.status());
    this.deps.assertDaemonLifecycleUnfenced();

    if (!status.running) {
      logger.info("[DaemonMcpProxy] Starting daemon...");
      await this.deps.daemonManager.start(this.daemonStartOptions());

      // Wait for daemon to be ready
      const ready = await this.deps.daemonManager.waitForReady(DAEMON_STARTUP_TIMEOUT_MS);
      if (!ready) {
        throw new DaemonUnavailableError(
          `Daemon failed to start within ${DAEMON_STARTUP_TIMEOUT_MS}ms`,
        );
      }
      this.deps.reconciliationSnapshot = undefined;
      await this.deps.reconciliationStatus();
      logger.info("[DaemonMcpProxy] Daemon started successfully");
      return;
    }

    // The daemon reports running but startDaemon is only reached when the
    // observation-only socket probe (DaemonClient.isAvailable) failed — i.e. the
    // socket is not connectable yet. A daemon in-progress startup writes its
    // early-owner PID record (daemon.ts writeEarlyOwnerRecord) BEFORE publishing
    // the Unix socket, which appears seconds later once DB init, device-pool
    // discovery, and iOS services complete. Treat that missing socket as pending
    // readiness, not a terminal error: wait behind the same bounded readiness
    // path so publication can complete instead of letting the subsequent
    // client.connect() fail immediately with "Daemon socket not found" (issue
    // #5664). waitForReady polls the socket + verifyDaemonConnection and never
    // unlinks a live daemon's socket, so stale-socket / dead-daemon handling and
    // the "do not replace a live daemon's socket" contract are preserved. A
    // genuinely wedged daemon that never publishes still fails promptly at the
    // deadline with an actionable error.
    //
    // This wait is nested inside a `tools/list` request that clients cut off at
    // ~30s (DAEMON_STARTUP_TIMEOUT_MS); if the error it can throw is produced only
    // as that deadline expires, the client sees an AutoMobile server with zero
    // tools and no error text (issue #5878, residual of #5871/#5874). So keep the
    // full startup budget while a live process is actively bringing the daemon up
    // — a legitimate concurrent cold start writes its early-owner PID (making
    // status.running true) seconds before it publishes the socket, and abandoning
    // it early would reject a start that was about to succeed — but exit the moment
    // no live startup-lock holder remains. A genuinely wedged or orphaned daemon
    // (early-owner record present, socket unreachable, no live holder finishing the
    // start) is then reported now instead of at the client's deadline, while the
    // concurrent-cold-start case keeps the budget it needs.
    // Re-arbitrate across replacement holders under one deadline, exactly like the
    // double-lock-contention loop in DaemonManager.start (issue #5904): if the live
    // holder A crashes and a replacement B reclaims the lock to finish the start, a
    // single liveness-gated waitForReady would give up on A and throw even though B
    // is now bringing the daemon up. waitForLockHolderReadiness keeps the full budget
    // per live holder and only reports failure once no live holder remains.
    const ready =
      await this.deps.daemonManager.waitForLockHolderReadiness(DAEMON_STARTUP_TIMEOUT_MS);
    if (!ready) {
      throw new DaemonUnavailableError(
        `Daemon reported running but its socket did not become reachable, and no live ` +
          `process is completing its startup`,
      );
    }
    this.deps.reconciliationSnapshot = undefined;
    await this.deps.reconciliationStatus();
    logger.info("[DaemonMcpProxy] Daemon reported running; socket became ready");
  }
}
