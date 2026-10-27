import { type IdentityRecoveryIO } from "../identityRecovery";
import { errorMessage } from "../../utils/describeUnknownError";
import { existsSync, readFileSync } from "node:fs";
import { logger } from "../../utils/logger";
import { ActionableError } from "../../models";
import {
  PID_FILE_PATH,
  DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS,
  DAEMON_START_PROCESS_TABLE_SCAN_MAX_ATTEMPTS,
  DAEMON_START_PROCESS_TABLE_SCAN_RETRY_DELAYS_MS,
  DEFAULT_DAEMON_PORT,
} from "../wire/constants";
import { DaemonStatus, PidFileData, DaemonOptions } from "../types";
import { sequenceBackoff } from "../../utils/Backoff";
import { type RetryExecutor } from "../../utils/retry/RetryExecutor";
import { recordedProcessGenerationToken } from "../processGenerationFields";
import {
  isShellCommandWrapper,
  DAEMON_SOCKET_PATH_FLAG,
  parseDaemonSocketPath,
  type DaemonProcessFinder,
  type DaemonProcessRecord,
} from "../processTable";
import { type DaemonPortAvailabilityChecker } from "../portAvailability";

/** Only the replaceable manager seams used by DaemonProcessDiscovery. */
export interface DaemonProcessDiscoveryHost {
  readonly pidFilePath: string;
  readonly processFinder: DaemonProcessFinder;
  findLiveDaemonProcessRecords(timeoutMs?: number): DaemonProcessRecord[];
  hasNamespaceRecordOrMarker(candidate: DaemonProcessRecord): boolean;
  findAllDaemonProcesses(timeoutMs?: number): number[];
  isProcessRunning(pid: number): boolean;
  readonly socketPath: string;
  recordedStatus(): DaemonStatus;
  matchesRecordedDaemonGeneration(status: DaemonStatus, candidate: DaemonProcessRecord): boolean;
  readonly identityRecoveryIO: IdentityRecoveryIO;
  probeNamespaceOwner(): Promise<DaemonStatus | undefined>;
  remainingTime(deadline: number): number;
  readonly retryExecutor: RetryExecutor;
  findNamespaceDaemonProcessRecords(timeoutMs?: number): Promise<DaemonProcessRecord[]>;
  readonly portAvailabilityChecker: DaemonPortAvailabilityChecker;
}

/** Daemon Process Discovery lifecycle operations. */
export class DaemonProcessDiscovery {
  constructor(private readonly host: DaemonProcessDiscoveryHost) {}

  cleanupSocketPaths(primarySocketPath?: string): string[] | undefined {
    if (this.host.pidFilePath === PID_FILE_PATH) {
      return undefined;
    }
    return primarySocketPath ? [primarySocketPath] : [];
  }

  /**
   * Find all running auto-mobile daemon processes (including those from other worktrees)
   */
  findAllDaemonProcesses(timeoutMs?: number): number[] {
    try {
      return this.normalizeDaemonProcessRecords(
        this.host.processFinder.findDaemonProcesses(timeoutMs),
      );
    } catch (error) {
      throw new ActionableError(`Failed to inspect daemon process table: ${errorMessage(error)}`);
    }
  }

  findOtherDaemonProcesses(activeDaemonPid: number | undefined): number[] {
    return this.host
      .findLiveDaemonProcessRecords()
      .filter((candidate) => this.host.hasNamespaceRecordOrMarker(candidate))
      .map((candidate) => candidate.pid)
      .filter((pid) => pid !== activeDaemonPid);
  }

  /**
   * @param timeoutMs Bounds the underlying process-table scan for a caller with a
   * tight remaining budget (issue #6140); see {@link DaemonProcessFinder.findDaemonProcesses}.
   */
  findLiveDaemonProcesses(timeoutMs?: number): number[] {
    return this.host
      .findAllDaemonProcesses(timeoutMs)
      .filter((pid) => this.host.isProcessRunning(pid));
  }

  findLiveDaemonProcessRecords(timeoutMs?: number): DaemonProcessRecord[] {
    try {
      const records = this.host.processFinder.findDaemonProcesses(timeoutMs);
      const daemonPids = new Set(this.normalizeDaemonProcessRecords(records));
      return records
        .filter((record) => daemonPids.has(record.pid) && this.host.isProcessRunning(record.pid))
        .map((record) => ({ ...record, socketPath: parseDaemonSocketPath(record.command) }));
    } catch (error) {
      throw new ActionableError(`Failed to inspect daemon process table: ${errorMessage(error)}`);
    }
  }

  hasNamespaceRecordOrMarker(candidate: DaemonProcessRecord): boolean {
    if (candidate.socketPath !== undefined) {
      return candidate.socketPath === this.host.socketPath;
    }
    // An invalid marker is not an unmarked legacy launch.
    if (candidate.command.includes(DAEMON_SOCKET_PATH_FLAG)) {
      return false;
    }
    const record = this.host.recordedStatus();
    return (
      record.running &&
      record.pid === candidate.pid &&
      this.host.matchesRecordedDaemonGeneration(record, candidate)
    );
  }

  async probeNamespaceOwner(): Promise<DaemonStatus | undefined> {
    try {
      const owner = await this.host.identityRecoveryIO.probe();
      return owner.running &&
        owner.pid !== undefined &&
        this.host.isProcessRunning(owner.pid) &&
        (owner.reportedSocketPath === undefined ||
          owner.reportedSocketPath === this.host.socketPath) &&
        (owner.reportedPidFilePath === undefined ||
          owner.reportedPidFilePath === this.host.pidFilePath)
        ? owner
        : undefined;
    } catch (error) {
      if (
        /ECONNREFUSED|ENOENT|Daemon socket not found|Failed to connect to daemon|timed out/i.test(
          errorMessage(error),
        )
      ) {
        // An absent or busy namespace socket grants no orphan ownership evidence.
        logger.debug("No namespace socket owner available for daemon discovery", error);
      } else {
        logger.warn("Failed to probe namespace socket ownership", error);
      }
      return undefined;
    }
  }

  async findNamespaceDaemonProcessRecords(timeoutMs?: number): Promise<DaemonProcessRecord[]> {
    const candidates = this.host.findLiveDaemonProcessRecords(timeoutMs);
    const owner =
      !this.host.recordedStatus().running ||
      candidates.some(
        (candidate) =>
          !this.host.hasNamespaceRecordOrMarker(candidate) &&
          !candidate.command.includes(DAEMON_SOCKET_PATH_FLAG),
      )
        ? await this.host.probeNamespaceOwner()
        : undefined;
    if (owner?.pid !== undefined && !candidates.some((candidate) => candidate.pid === owner.pid)) {
      candidates.push({
        pid: owner.pid,
        ppid: 0,
        command: "",
        startedAt: owner.processStartedAt ?? owner.startedAt,
        processGenerationToken: recordedProcessGenerationToken(owner),
      });
    }
    return candidates.filter((candidate) => {
      const ours =
        this.host.hasNamespaceRecordOrMarker(candidate) ||
        (!candidate.command.includes(DAEMON_SOCKET_PATH_FLAG) && owner?.pid === candidate.pid);
      if (!ours) {
        logger.debug(`Ignoring daemon PID ${candidate.pid}: no evidence for this socket namespace`);
      }
      return ours;
    });
  }

  /**
   * Startup can still determine socket ownership through the PID/lock/readiness
   * path when a loaded host times out while listing processes. A successful port
   * probe forces strict-port launch because it closes its probe socket before the
   * child binds; the child's own bind is the authoritative guard. Keep that narrowly
   * scoped degradation out of the fail-closed lifecycle scans used elsewhere.
   *
   * Public so tests can drive the scan directly.
   */
  async findLiveDaemonProcessesForStart(
    options: DaemonOptions,
    startDeadline: number,
  ): Promise<number[]> {
    const scanBudget = this.host.remainingTime(startDeadline);
    if (scanBudget <= 0) {
      throw new ActionableError(
        "Daemon startup deadline elapsed before process-table inspection could complete; refusing to launch a daemon after the client deadline.",
      );
    }

    // RetryExecutor already owns the retry/backoff policy. Limit each scan and
    // each one of its existing sequence-backoff delays to time still available
    // under this start request rather than beginning an independent timeout window.
    const scanBackoff = sequenceBackoff(DAEMON_START_PROCESS_TABLE_SCAN_RETRY_DELAYS_MS);
    const result = await this.host.retryExecutor.execute(
      async () => {
        const remaining = this.host.remainingTime(startDeadline);
        if (remaining <= 0) {
          throw new Error("Process-table inspection ETIMEDOUT before daemon startup deadline");
        }
        return (
          await this.host.findNamespaceDaemonProcessRecords(
            Math.min(DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS, remaining),
          )
        ).map((candidate) => candidate.pid);
      },
      {
        maxAttempts: DAEMON_START_PROCESS_TABLE_SCAN_MAX_ATTEMPTS,
        expectedFailure: {
          reason:
            "Startup handles scan timeouts with namespace ownership probes and a degradation warning",
          matches: (error) => error.message.includes("ETIMEDOUT"),
        },
        delays: (attempt) =>
          Math.min(scanBackoff.delayForAttempt(attempt), this.host.remainingTime(startDeadline)),
        shouldRetry: (error) =>
          error.message.includes("ETIMEDOUT") && this.host.remainingTime(startDeadline) > 0,
      },
    );

    if (this.host.remainingTime(startDeadline) <= 0) {
      throw new ActionableError(
        "Daemon startup deadline elapsed during process-table inspection; refusing to launch a daemon after the client deadline.",
      );
    }

    if (result.success) {
      return result.value ?? [];
    }

    const error = result.error ?? new Error("Process-table inspection failed without an error");
    if (!error.message.includes("ETIMEDOUT")) {
      throw error;
    }

    // Port occupancy alone cannot attribute a process to this socket namespace.
    const owner = await this.host.probeNamespaceOwner();
    if (owner?.pid !== undefined) {
      return [owner.pid];
    }
    const occupied = await this.findOccupiedDaemonStartPort(
      this.degradedStartProbeTargets(options),
      this.host.remainingTime(startDeadline),
    );
    if (occupied === undefined) {
      options.strictPort = true;
    }
    // A foreign listener can occupy the default port; allow the normal fallback
    // while the namespace lock/socket bind guard protects against duplicate owners.
    logger.warn(
      `[DaemonManager] process-table inspection timed out during daemon start; proceeding with namespace ownership checks: ${errorMessage(error)}`,
      error,
    );
    return [];
  }

  /**
   * Every (host, port) pair the degraded scan must probe: each candidate port on
   * the configured host plus the loopback alternates, configured host first so
   * the incumbent most likely to own this install's socket is reported.
   */
  private degradedStartProbeTargets(options: DaemonOptions): DaemonStartProbeTarget[] {
    const hosts = [
      ...new Set([options.host ?? DEFAULT_DAEMON_HOST, ...DEGRADED_START_PROBE_LOOPBACK_HOSTS]),
    ];
    return this.degradedStartProbePorts(options).flatMap((port) =>
      hosts.map((host) => ({ host, port })),
    );
  }

  private degradedStartProbePorts(options: DaemonOptions): number[] {
    const configuredPort = options.port ?? DEFAULT_DAEMON_PORT;
    const candidatePorts = [configuredPort];
    if (DEFAULT_DAEMON_PORT !== configuredPort) {
      candidatePorts.push(DEFAULT_DAEMON_PORT);
    }
    const persistedPort = this.readPersistedDaemonOwnerPortForStart();
    if (persistedPort !== undefined && !candidatePorts.includes(persistedPort)) {
      candidatePorts.push(persistedPort);
    }
    return candidatePorts;
  }

  private readPersistedDaemonOwnerPortForStart(): number | undefined {
    if (!existsSync(this.host.pidFilePath)) {
      logger.debug(
        `[DaemonManager] no persisted daemon owner record was available while widening the degraded process-table scan probe: ${this.host.pidFilePath}`,
      );
      return undefined;
    }
    try {
      const pidData: PidFileData = JSON.parse(readFileSync(this.host.pidFilePath, "utf8"));
      if (typeof pidData.port === "number") {
        return pidData.port;
      }
      logger.debug(
        `[DaemonManager] persisted daemon owner record has no usable port while widening the degraded process-table scan probe: ${this.host.pidFilePath}`,
      );
    } catch (pidFileError) {
      // Safe to continue: this is only a best-effort expansion of the ownership probe.
      logger.debug(
        `[DaemonManager] failed to read persisted daemon owner record while widening the degraded process-table scan probe: ${errorMessage(pidFileError)}`,
      );
    }
    return undefined;
  }

  /**
   * Probes every target concurrently, each bounded by the SAME remaining start
   * budget, so the whole set costs one probe's wall time and can never push the
   * actionable result past the client deadline (issue #7001). The first occupied
   * target in candidate order wins so the reported incumbent is deterministic.
   */
  private async findOccupiedDaemonStartPort(
    targets: DaemonStartProbeTarget[],
    budgetMs: number,
  ): Promise<DaemonStartProbeTarget | undefined> {
    const results = await Promise.all(
      targets.map((target) =>
        this.host.portAvailabilityChecker.isPortFree(target.port, target.host, budgetMs),
      ),
    );
    return targets.find((_, index) => !results[index]);
  }

  private normalizeDaemonProcessRecords(records: DaemonProcessRecord[]): number[] {
    const wrapperPids = new Set<number>();
    const childPpids = new Set(records.map((record) => record.ppid));

    for (const record of records) {
      if (isShellCommandWrapper(record.command) && childPpids.has(record.pid)) {
        wrapperPids.add(record.pid);
      }
    }

    const pids: number[] = [];
    const seen = new Set<number>();

    for (const record of records) {
      if (record.pid === process.pid || wrapperPids.has(record.pid) || seen.has(record.pid)) {
        continue;
      }

      pids.push(record.pid);
      seen.add(record.pid);
    }

    return pids;
  }
}

/** Host a daemon binds when `--host` is not given; mirrors the CLI default. */
export const DEFAULT_DAEMON_HOST = "127.0.0.1";

/**
 * Loopback addresses the degraded start scan probes in addition to the
 * configured host (issue #7001): a port bound on one is invisible from the other,
 * so an incumbent on the default 127.0.0.1 must still be found by a `::1` start.
 */
const DEGRADED_START_PROBE_LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;

interface DaemonStartProbeTarget {
  host: string;
  port: number;
}
