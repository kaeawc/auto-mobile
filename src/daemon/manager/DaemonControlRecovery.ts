import { errorMessage } from "../../utils/describeUnknownError";
import { readFile } from "node:fs/promises";
import { logger } from "../../utils/logger";
import { ActionableError } from "../../models";
import { DAEMON_RESTART_HANDOFF_DELAY_MS } from "../wire/constants";
import { DaemonStatus, PidFileData, DaemonOptions } from "../types";
import {
  mergeRestartOptions,
  restartResultFromStart,
  type DaemonRestartResult,
} from "../daemonRestart";
import { Timer } from "../../utils/SystemTimer";
import {
  compareProcessGenerationTokens,
  type ProcessGenerationTokenComparison,
} from "../processGeneration";
import { recordedProcessGenerationToken } from "../processGenerationFields";
import { daemonProcessOptions } from "../daemonOptionScopes";
import { type DaemonProcessRecord } from "../processTable";
import { stderrLog } from "./DaemonLaunch";
import type { DaemonStartResult } from "../manager";

/** Only the replaceable manager seams used by DaemonControlRecovery. */
export interface DaemonControlRecoveryHost {
  throwIfRecoveryCancelled(signal: AbortSignal | undefined): void;
  acquireLock(): boolean;
  startByAwaitingLockHolder(
    options: DaemonOptions,
    recoverySignal?: AbortSignal,
    onTakeover?: () => Promise<DaemonStartResult>,
  ): Promise<DaemonStartResult>;
  releaseLock(): void;
  lifecycleStatus(): Promise<DaemonStatus>;
  findNamespaceDaemonProcessRecords(timeoutMs?: number): Promise<DaemonProcessRecord[]>;
  remainingRecoveryTime(recoveryDeadline: number | undefined): number | undefined;
  recoveryOptions(status: DaemonStatus, options: DaemonOptions): Promise<DaemonOptions>;
  assertNoSurvivingDaemonBeforeRestart(
    options: DaemonOptions,
    recoveryDeadline?: number,
  ): Promise<void>;
  readonly timer: Timer;
  startUnlocked(
    options: DaemonOptions,
    recoverySignal?: AbortSignal,
    inheritExitRecord?: boolean,
  ): Promise<DaemonStartResult>;
  readonly socketPath: string;
  matchesRecordedDaemonGeneration(status: DaemonStatus, candidate: DaemonProcessRecord): boolean;
  stopUnrecordedDaemonProcess(
    expected: DaemonProcessRecord,
    recoveryDeadline: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void>;
  remainingTime(deadline: number): number;
  readonly pidFilePath: string;
}

/** Daemon Control Recovery lifecycle operations. */
export class DaemonControlRecovery {
  constructor(private readonly host: DaemonControlRecoveryHost) {}
  /**
   * Recover a previously-unusable daemon control socket. Unlike a general
   * `restart()`, this takes the namespace startup lock *before* deciding
   * whether to stop anything, then makes a fresh protocol probe while holding
   * it. A concurrent recovery/start therefore publishes a healthy successor
   * that this call joins instead of deleting its socket or terminating it.
   *
   * This is deliberately invoked only after an initial health check fails. It
   * still stops only processes whose current
   * command line identifies them as AutoMobile daemon-mode processes, never a
   * PID named solely by stale control metadata.
   */
  async recoverControlState(
    options: DaemonOptions,
    isProtocolHealthy: () => Promise<boolean>,
    signal?: AbortSignal,
    recoveryDeadline?: number,
  ): Promise<DaemonRestartResult> {
    this.host.throwIfRecoveryCancelled(signal);
    if (!this.host.acquireLock()) {
      return restartResultFromStart(
        await this.host.startByAwaitingLockHolder(options, signal, async () => {
          const result = await this.recoverControlStateWhileLocked(
            options,
            isProtocolHealthy,
            signal,
            recoveryDeadline,
          );
          return result === "restarted" ? "started" : "joined";
        }),
      );
    }

    try {
      return await this.recoverControlStateWhileLocked(
        options,
        isProtocolHealthy,
        signal,
        recoveryDeadline,
      );
    } finally {
      this.host.releaseLock();
    }
  }

  /**
   * Recovery transition for a lifecycle lock that the caller already owns.
   * Lock-contended recovery uses this after the prior holder exits so its
   * takeover retains the same successor, process, port, and strict-port checks
   * as an uncontended repair.
   */
  private async recoverControlStateWhileLocked(
    options: DaemonOptions,
    isProtocolHealthy: () => Promise<boolean>,
    signal: AbortSignal | undefined,
    recoveryDeadline: number | undefined,
  ): Promise<DaemonRestartResult> {
    if (await isProtocolHealthy()) {
      this.host.throwIfRecoveryCancelled(signal);
      stderrLog("Daemon became healthy during control-state recovery; joining it.");
      return "joined";
    }

    this.host.throwIfRecoveryCancelled(signal);
    const status = await this.host.lifecycleStatus();
    this.host.throwIfRecoveryCancelled(signal);
    const candidates = await this.host.findNamespaceDaemonProcessRecords(
      this.host.remainingRecoveryTime(recoveryDeadline),
    );
    const recordedCandidate = this.findRecoveryCandidate(status, candidates);
    this.assertRecoveryCandidateIsScoped(
      status,
      candidates.map((candidate) => candidate.pid),
      recordedCandidate,
    );
    this.host.throwIfRecoveryCancelled(signal);
    await this.stopRecoveryCandidate(recordedCandidate, signal, recoveryDeadline);

    // A cancellation after SIGTERM must still let the verified stop settle,
    // but must never begin a replacement daemon that the caller will no
    // longer wait to verify.
    this.host.throwIfRecoveryCancelled(signal);
    const recoveryOptions = await this.host.recoveryOptions(status, options);
    this.host.throwIfRecoveryCancelled(signal);
    await this.host.assertNoSurvivingDaemonBeforeRestart(recoveryOptions, recoveryDeadline);
    this.host.throwIfRecoveryCancelled(signal);
    await this.host.timer.sleep(DAEMON_RESTART_HANDOFF_DELAY_MS);
    this.host.throwIfRecoveryCancelled(signal);
    return restartResultFromStart(
      await this.host.startUnlocked(recoveryOptions, signal, !status.running),
    );
  }

  private findRecoveryCandidate(
    status: DaemonStatus,
    candidates: DaemonProcessRecord[],
  ): DaemonProcessRecord | undefined {
    if (!status.running || status.pid === undefined || status.socketPath !== this.host.socketPath) {
      return undefined;
    }
    const candidate = candidates.find((process) => process.pid === status.pid);
    if (!candidate || !this.host.matchesRecordedDaemonGeneration(status, candidate)) {
      return undefined;
    }
    return candidate;
  }

  /**
   * Compare a PID file to the process table using the OS process-birth value
   * written by current daemons. PID files from before that field existed retain
   * a narrow, symmetric startedAt fallback: it supports normal old records but
   * refuses a slow-bootstrap process rather than accepting one merely because
   * it happens to be older than daemon initialization.
   */
  matchesRecordedDaemonGeneration(status: DaemonStatus, candidate: DaemonProcessRecord): boolean {
    const tokenVerdict = this.compareRecordedTokens(
      recordedProcessGenerationToken(status),
      candidate.processGenerationToken,
    );
    if (tokenVerdict !== "incomparable") {
      return tokenVerdict === "same";
    }
    const expectedStartedAt = status.processStartedAt ?? status.startedAt;
    return (
      expectedStartedAt !== undefined &&
      candidate.startedAt !== undefined &&
      Math.abs(candidate.startedAt - expectedStartedAt) <=
        DAEMON_PROCESS_BIRTH_IDENTITY_TOLERANCE_MS
    );
  }

  matchesObservedDaemonGeneration(
    expected: DaemonProcessRecord,
    candidate: DaemonProcessRecord,
  ): boolean {
    const tokenVerdict = this.compareRecordedTokens(
      expected.processGenerationToken,
      candidate.processGenerationToken,
    );
    if (tokenVerdict !== "incomparable") {
      return expected.pid === candidate.pid && tokenVerdict === "same";
    }
    return (
      expected.pid === candidate.pid &&
      expected.startedAt !== undefined &&
      candidate.startedAt !== undefined &&
      Math.abs(candidate.startedAt - expected.startedAt) <=
        DAEMON_PROCESS_BIRTH_IDENTITY_TOLERANCE_MS
    );
  }

  /**
   * Verdict of a recorded token against an observed one. "incomparable" means
   * the legacy birth-time rule applies: no recorded token at all, or tokens from
   * different schemes (a record written by an older build against a token this
   * build read; see `compareProcessGenerationTokens`). A recorded token with no
   * observed token is "different": the token-bearing process must be proven.
   */
  private compareRecordedTokens(
    recorded: string | undefined,
    observed: string | undefined,
  ): ProcessGenerationTokenComparison {
    if (recorded === undefined) {
      return "incomparable";
    }
    return observed === undefined
      ? "different"
      : compareProcessGenerationTokens(recorded, observed);
  }

  isConfirmedDifferentDaemonGeneration(
    expected: DaemonProcessRecord,
    candidate: DaemonProcessRecord,
  ): boolean {
    if (expected.pid !== candidate.pid) {
      return false;
    }
    if (expected.processGenerationToken !== undefined) {
      // An unreadable token is never proof of a different generation.
      if (candidate.processGenerationToken === undefined) {
        return false;
      }
      const verdict = compareProcessGenerationTokens(
        expected.processGenerationToken,
        candidate.processGenerationToken,
      );
      // Only a token from the same comparable scheme proves a different
      // generation or the same one. An older-scheme token (a daemon that wrote a
      // legacy `darwin:` token, replaced by one that reads `darwin-utc:`) is
      // neither, so the birth-time rule below decides, exactly as in the two
      // `matches*` helpers.
      if (verdict !== "incomparable") {
        return verdict === "different";
      }
    }
    return (
      expected.startedAt !== undefined &&
      candidate.startedAt !== undefined &&
      Math.abs(candidate.startedAt - expected.startedAt) >
        DAEMON_PROCESS_BIRTH_IDENTITY_TOLERANCE_MS
    );
  }

  private assertRecoveryCandidateIsScoped(
    status: DaemonStatus,
    candidates: number[],
    recordedCandidate: DaemonProcessRecord | undefined,
  ): void {
    if (candidates.length > 0 && (recordedCandidate === undefined || candidates.length > 1)) {
      throw new ActionableError(
        "Daemon recovery could not correlate the failed control socket with exactly one live " +
          "AutoMobile daemon process. Refusing to stop an uncorrelated daemon; inspect " +
          "the namespace PID record and socket before retrying.",
      );
    }
    if (status.running && recordedCandidate === undefined) {
      throw new ActionableError(
        "Daemon recovery found live PID control metadata that does not match a current " +
          "AutoMobile daemon process. Refusing to signal a potentially reused PID.",
      );
    }
  }

  throwIfRecoveryCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new ActionableError(
        "Daemon recovery deadline elapsed before a safe recovery transition could complete.",
      );
    }
  }

  private async stopRecoveryCandidate(
    recordedCandidate: DaemonProcessRecord | undefined,
    signal: AbortSignal | undefined,
    recoveryDeadline: number | undefined,
  ): Promise<void> {
    if (recordedCandidate === undefined) {
      return;
    }
    this.host.throwIfRecoveryCancelled(signal);
    stderrLog(
      `Repair force-stopping the verified daemon for this control namespace (PID ${recordedCandidate.pid})...`,
    );
    await this.host.stopUnrecordedDaemonProcess(recordedCandidate, recoveryDeadline, signal);
  }

  remainingRecoveryTime(recoveryDeadline: number | undefined): number | undefined {
    if (recoveryDeadline === undefined) {
      return undefined;
    }
    const remaining = this.host.remainingTime(recoveryDeadline);
    if (remaining <= 0) {
      throw new ActionableError(
        "Daemon recovery deadline elapsed before process-table inspection could complete.",
      );
    }
    return remaining;
  }

  async recoveryOptions(status: DaemonStatus, options: DaemonOptions): Promise<DaemonOptions> {
    const recordedOptions = status.options ?? (await this.readRecoveryOptionsFromPidFile());
    // CLI parsing materializes omitted one-way flags as false. False has no
    // corresponding "disable" argument, so forwarding it here would erase a
    // PID-recorded true option without an explicit user request.
    const requestedOptions = daemonProcessOptions(
      Object.fromEntries(
        Object.entries(options).filter(([, value]) => value !== undefined && value !== false),
      ) as DaemonOptions,
    );
    return mergeRestartOptions(daemonProcessOptions(recordedOptions), requestedOptions);
  }

  private async readRecoveryOptionsFromPidFile(): Promise<DaemonOptions> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.host.pidFilePath, "utf-8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      const pidData = parsed as Partial<PidFileData>;
      const options =
        pidData.options && typeof pidData.options === "object" && !Array.isArray(pidData.options)
          ? pidData.options
          : {};
      // Older PID files predate the options object but still record their
      // bound port. Preserve it so a dead-record recovery probes/restarts the
      // same endpoint rather than silently returning to the default.
      return {
        ...options,
        ...(typeof pidData.port === "number" && options.port === undefined
          ? { port: pidData.port }
          : {}),
      };
    } catch (error) {
      // Safe: missing options grant no process ownership; recovery still verifies the generation.
      logger.debug(`Unable to recover daemon options from PID metadata: ${errorMessage(error)}`);
      return {};
    }
  }
}

/**
 * Process tables expose only second-granularity birth data on some supported
 * platforms. Keep a small allowance for that representation, but compare both
 * directions: an older process is not interchangeable with this generation.
 */
const DAEMON_PROCESS_BIRTH_IDENTITY_TOLERANCE_MS = 2_000;
