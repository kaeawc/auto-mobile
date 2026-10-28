import { ActionableError } from "../models";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import {
  DAEMON_FORCED_STOP_TIMEOUT_MS,
  DAEMON_RESTART_HANDOFF_DELAY_MS,
  DAEMON_SHUTDOWN_TIMEOUT_MS,
} from "./wire/constants";
import type { DaemonClientFactoryOptions, DaemonClientLike } from "./client/client";
import { daemonProcessOptions } from "./daemonOptionScopes";
import {
  DAEMON_COMMIT_ACCEPTANCE_RESTART_METHOD,
  DAEMON_RELEASE_ACCEPTANCE_RESTART_METHOD,
  DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD,
  DaemonRestartDeferredError,
  type AcceptanceSessionRestartScope,
  type DaemonAcceptanceRestartCommit,
  type DaemonAcceptanceSessionRestart,
  type DaemonAdmittedRestart,
  type DaemonRestartPreparation,
} from "./daemonRestartAdmission";
import { mergeDaemonStartupOptions } from "./daemonExitRecord";
import type { DaemonProcessRecord } from "./processTable";
import {
  createDaemonLiveAcceptanceScopedCapability,
  daemonGenerationIdentityFromStatus,
  daemonLiveAcceptanceStartupSecret,
  type DaemonGenerationIdentity,
} from "./liveAcceptanceCapability";
import { recordedProcessGenerationToken } from "./processGenerationFields";
import type { DaemonStartResult } from "./manager";
import {
  deferredRestartError,
  type TakeoverDeferralLedger,
} from "./manager/TakeoverDeferralLedger";
import type { DaemonOptions, DaemonStatus } from "./types";

/**
 * The outcome of a daemon restart attempt.
 *
 * A conditional restart can join a successor selected by another client instead
 * of replacing it. Callers must re-read that successor before declaring their
 * startup options incompatible.
 */
export type DaemonRestartResult = "restarted" | "joined";

export interface DaemonStopWaitResult {
  stopped: boolean;
  replacedByOtherGeneration: boolean;
}

/**
 * The narrow slice of DaemonManager the restart variants drive. DaemonManager
 * implements it by delegating to its own methods, so the lifecycle primitives
 * stay in one place and the restart sequencing can be tested with a fake.
 */
export interface DaemonRestartHost {
  readonly takeoverDeferrals: TakeoverDeferralLedger;
  now(): number;
  log(message: string): void;
  sleep(ms: number): Promise<void>;
  acquireLock(): boolean;
  releaseLock(): void;
  createClient(options?: DaemonClientFactoryOptions): DaemonClientLike;

  lifecycleStatus(): Promise<DaemonStatus>;
  recordedStatus(): DaemonStatus;
  probeRecoveryOwner(): Promise<DaemonStatus>;
  isRecoveryOwnerReference(expected: DaemonStatus | undefined): boolean;
  isRecoveryOwner(owner: DaemonStatus): boolean;
  hasPublishedRecoveryIdentity(owner: DaemonStatus): boolean;
  isSameDaemonGeneration(current: DaemonStatus, expected: DaemonStatus): boolean;
  isConfirmedDifferentDaemonGeneration(
    expected: DaemonProcessRecord,
    candidate: DaemonProcessRecord,
  ): boolean;
  daemonProcessRecordFromStatus(status: DaemonStatus): DaemonProcessRecord;
  isProcessRunning(pid: number): boolean;
  signalProcess(pid: number, signal: NodeJS.Signals): void;

  stop(timeout?: number, expected?: DaemonStatus): Promise<void>;
  stopRunningDaemon(status: DaemonStatus, timeout?: number, signalFirst?: boolean): Promise<void>;
  stopNamespaceOrphansForExplicitRestart(recordedPid?: number): Promise<void>;
  awaitRestartCleanup(operations: ReadonlyArray<() => void | Promise<void>>): Promise<void>;
  waitForStop(
    pid: number,
    timeout: number,
    expectedGeneration?: DaemonProcessRecord,
  ): Promise<DaemonStopWaitResult>;
  assertNoSurvivingDaemonBeforeRestart(options: DaemonOptions): Promise<void>;
  cleanupAcceptanceRestartFiles(
    status: DaemonStatus,
    replacedByOtherGeneration: boolean,
  ): Promise<void>;
  verifyDaemonGenerationBeforeSignal(
    expected: DaemonProcessRecord,
    recoveryDeadline: number | undefined,
    context: string,
  ): Promise<boolean>;

  prepareDaemonForConditionalRestart(expected: DaemonStatus): Promise<DaemonRestartPreparation>;
  prepareIdentityRecoveryRestart(expected: DaemonStatus): Promise<DaemonRestartPreparation>;
  admitMaintenanceRestart(
    expected: DaemonStatus,
    maintenanceToken: string,
  ): Promise<DaemonAdmittedRestart>;

  start(options: DaemonOptions): Promise<DaemonStartResult>;
  startWithRunningOptions(options: DaemonOptions): Promise<DaemonStartResult>;
  startUnlocked(
    options: DaemonOptions,
    recoverySignal?: AbortSignal,
    inheritExitRecord?: boolean,
  ): Promise<DaemonStartResult>;
}

export function restartResultFromStart(result: DaemonStartResult): DaemonRestartResult {
  return result === "joined" ? "joined" : "restarted";
}

export function mergeRestartOptions(
  running: DaemonOptions,
  requested: DaemonOptions,
): DaemonOptions {
  return { ...mergeDaemonStartupOptions(running, requested), strictPort: true };
}

/**
 * Restart the daemon
 */
export async function restartDaemon(
  host: DaemonRestartHost,
  options: DaemonOptions = {},
  expectedDaemon?: DaemonStatus,
): Promise<DaemonRestartResult> {
  host.log("Restarting daemon...");
  // A bare `--daemon restart` has no CLI options, but it is commonly used to
  // replace a stale checkout. Preserve the daemon's PID-recorded options so
  // that replacement cannot silently discard configuration such as debug,
  // output, or accessibility flags.
  const recovering = expectedDaemon !== undefined && host.isRecoveryOwnerReference(expectedDaemon);
  const status = recovering ? await host.probeRecoveryOwner() : await host.lifecycleStatus();
  if (recovering && !host.isRecoveryOwner(status)) {
    throw new DaemonRestartDeferredError("Provider identity changed before replacement");
  }
  if (recovering && host.hasPublishedRecoveryIdentity(status)) {
    return "joined";
  }
  const runningOptions = daemonProcessOptions({
    ...status.options,
    ...(status.port === undefined ? {} : { port: status.port }),
  });
  const requestedOptions = daemonProcessOptions(
    Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined),
    ) as DaemonOptions,
  );
  // Force the authoritative bind-or-fail guard (issue #6260, PRRT ft82d):
  // the preflight check in assertNoSurvivingDaemonBeforeRestart below is
  // fast feedback only — it releases its probe socket before this sleep and
  // before the child actually binds, so a competitor can still win the
  // canonical port in that window. strictPort makes the child's own
  // listen() call the atomic guard, failing loudly instead of silently
  // falling back to a higher port in the range and recreating the split-brain.
  const restartOptions = mergeRestartOptions(runningOptions, requestedOptions);
  if (expectedDaemon && !host.isSameDaemonGeneration(status, expectedDaemon)) {
    host.log("Daemon generation changed before restart; joining the current generation");
    return "joined";
  }

  if (expectedDaemon) {
    return restartExpectedGeneration(host, status, expectedDaemon, restartOptions, recovering);
  }

  return restartNamespace(host, status, restartOptions);
}

export async function restartNamespace(
  host: DaemonRestartHost,
  status: DaemonStatus,
  options: DaemonOptions,
): Promise<DaemonRestartResult> {
  // Stop only this namespace's observed generation and attributable orphans.
  // Keep the bounded graceful + forced-stop cleanup window.
  await host.awaitRestartCleanup([
    () => (status.running ? host.stop(DAEMON_SHUTDOWN_TIMEOUT_MS, status) : undefined),
    () => host.stopNamespaceOrphansForExplicitRestart(status.pid),
  ]);
  // Confirm the previous daemon(s) are actually gone before starting a
  // replacement (issue #6260). `awaitRestartCleanup` above only rejects when a
  // DISCOVERED candidate refused to stop; it cannot catch a candidate that
  // process-table discovery never found in the first place — the exact split-
  // brain #6260 reports, where `--daemon restart` printed no stop line at all,
  // then silently started a second daemon on a fallback port and reported
  // unqualified success while the old one kept CtrlProxy forwarding ownership.
  // Failing loudly here, naming the orphan, is strictly better than that.
  if (status.pid !== undefined && host.isProcessRunning(status.pid)) {
    throw new ActionableError(
      "Restart could not confirm the namespace's previous daemon exited; refusing to start a replacement.",
    );
  }
  await host.assertNoSurvivingDaemonBeforeRestart(options);
  // Wait a bit before starting
  await host.sleep(DAEMON_RESTART_HANDOFF_DELAY_MS);
  const startResult = status.running
    ? await host.startWithRunningOptions(options)
    : await host.start(options);
  const successor = host.recordedStatus();
  if (
    status.running &&
    successor.pid === status.pid &&
    !host.isConfirmedDifferentDaemonGeneration(
      host.daemonProcessRecordFromStatus(status),
      host.daemonProcessRecordFromStatus(successor),
    )
  ) {
    throw new ActionableError(
      "Restart did not replace the namespace's previous daemon generation.",
    );
  }
  return restartResultFromStart(startResult);
}

async function prepareExpectedGenerationRestart(
  host: DaemonRestartHost,
  expected: DaemonStatus,
  recovering: boolean,
): Promise<boolean> {
  let preparation: DaemonRestartPreparation;
  try {
    preparation = recovering
      ? await host.prepareIdentityRecoveryRestart(expected)
      : await host.prepareDaemonForConditionalRestart(expected);
  } catch (error) {
    if (error instanceof DaemonRestartDeferredError) {
      throw deferredRestartError({
        ledger: host.takeoverDeferrals,
        incumbent: expected,
        kind: error.refusalReason === "active_operations" ? "active_operations" : "unavailable",
        original: error,
        nowMs: host.now(),
        subject: "daemon",
      });
    }
    throw error;
  }
  if (preparation.accepted) {
    return true;
  }
  if (preparation.reason === "generation_changed" || preparation.reason === "restart_pending") {
    return false;
  }
  const kind = preparation.reason === "active_operations" ? "active_operations" : "unavailable";
  const reason =
    preparation.reason === "active_operations"
      ? "a device operation is active"
      : preparation.reason === "shutdown_unavailable"
        ? "the daemon could not initiate its own shutdown"
        : "the daemon returned an unrecognized safe-restart admission result";
  throw deferredRestartError({
    ledger: host.takeoverDeferrals,
    incumbent: expected,
    kind,
    original: new DaemonRestartDeferredError(reason),
    nowMs: host.now(),
    subject: "daemon",
  });
}

export async function restartExpectedGeneration(
  host: DaemonRestartHost,
  status: DaemonStatus,
  expected: DaemonStatus,
  options: DaemonOptions,
  recovering: boolean,
): Promise<DaemonRestartResult> {
  if (!(await prepareExpectedGenerationRestart(host, expected, recovering))) {
    host.log("Daemon restart is already in progress; joining its successor");
    return "joined";
  }
  host.takeoverDeferrals.clear();
  if (status.running) {
    // Atomic admission asks the daemon to initiate its own shutdown before
    // acknowledging. Waiting without a second SIGTERM prevents a delayed
    // manager from acting on stale admission state.
    await host.stopRunningDaemon(status, DAEMON_SHUTDOWN_TIMEOUT_MS, false);
  }
  // Another automatic client may win the shared startup lock during this
  // handoff. Ordinary start() joins that winner instead of terminating it.
  await host.sleep(DAEMON_RESTART_HANDOFF_DELAY_MS);
  // Recovery already owns the startup lock; do not recursively acquire it.
  const startResult = recovering
    ? await host.startUnlocked(options, undefined, !status.running)
    : status.running
      ? await host.startWithRunningOptions(options)
      : await host.start(options);
  return restartResultFromStart(startResult);
}

/**
 * Complete a host-maintenance restart only after the generation that minted
 * its opaque maintenance token accepts it. This RPC is intentionally the
 * first lifecycle action: a successor that replaced the admitted daemon
 * cannot present the old token, so no stop, process-table scan, socket
 * cleanup, or replacement launch can follow a stale admission.
 */
export async function restartAdmitted(
  host: DaemonRestartHost,
  options: DaemonOptions,
  maintenanceToken: string,
): Promise<DaemonRestartResult> {
  if (!maintenanceToken) {
    throw new ActionableError("restart-admitted requires a maintenance admission token.");
  }
  if (!host.acquireLock()) {
    throw new DaemonRestartDeferredError("another daemon lifecycle transition is in progress");
  }
  try {
    return await restartAdmittedWhileLocked(host, options, maintenanceToken);
  } finally {
    host.releaseLock();
  }
}

export async function restartAdmittedWhileLocked(
  host: DaemonRestartHost,
  options: DaemonOptions,
  maintenanceToken: string,
): Promise<DaemonRestartResult> {
  const status = await host.lifecycleStatus();
  if (!status.running) {
    throw new ActionableError(
      "restart-admitted requires the daemon generation that admitted maintenance to still be running.",
    );
  }

  const admission = await host.admitMaintenanceRestart(status, maintenanceToken);
  if (!admission.accepted) {
    throw new DaemonRestartDeferredError(
      `maintenance admission is no longer valid (${admission.reason ?? "unknown"})`,
    );
  }

  const restartOptions = mergeRestartOptions(
    daemonProcessOptions(status.options),
    daemonProcessOptions(
      Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
    ),
  );
  // The admitted daemon has already initiated its own SIGTERM before it
  // acknowledges. Preserve the exact pre-admission status through the wait;
  // a later status read could name its replacement instead.
  await host.stopRunningDaemon(status, DAEMON_SHUTDOWN_TIMEOUT_MS, false);
  await host.sleep(DAEMON_RESTART_HANDOFF_DELAY_MS);
  return restartResultFromStart(await host.startUnlocked(restartOptions, undefined, false));
}

/**
 * Crash and replace one verified live-acceptance daemon generation without a
 * graceful shutdown. This preserves precisely one authenticated persisted
 * session row for recovery testing; the admission RPC rejects unrelated
 * sessions and active operations before this manager signals the process.
 */
export async function restartAcceptanceSession(
  host: DaemonRestartHost,
  scope: AcceptanceSessionRestartScope,
): Promise<DaemonRestartResult> {
  const startupSecret = daemonLiveAcceptanceStartupSecret();
  if (!startupSecret) {
    throw new ActionableError(
      "restart-acceptance-session requires a live-acceptance daemon startup capability.",
    );
  }
  if (!host.acquireLock()) {
    throw new ActionableError(
      "restart-acceptance-session could not acquire the daemon startup lock.",
    );
  }
  try {
    return await restartAcceptanceSessionWhileLocked(host, scope, startupSecret);
  } finally {
    host.releaseLock();
  }
}

export async function restartAcceptanceSessionWhileLocked(
  host: DaemonRestartHost,
  scope: AcceptanceSessionRestartScope,
  startupSecret: string,
): Promise<DaemonRestartResult> {
  const status = await host.lifecycleStatus();
  if (!status.running) {
    throw new ActionableError(
      "restart-acceptance-session requires the admitted daemon generation to be running.",
    );
  }
  const generation = daemonGenerationIdentityFromStatus(status);
  if (!generation) {
    throw new ActionableError(
      "restart-acceptance-session requires the admitted daemon generation identity.",
    );
  }
  const client = host.createClient({ clientIdentity: null });
  let restartToken: string | undefined;
  let signalSent = false;
  let primaryError: unknown;
  let replacedByOtherGeneration = false;
  try {
    await client.connect();
    restartToken = await requestAcceptanceRestartAdmission(
      host,
      client,
      status,
      generation,
      scope,
      startupSecret,
    );
    await commitAcceptanceRestartAdmission(host, client, status, restartToken);
    if (await verifyAcceptanceGenerationBeforeSignal(host, status, generation)) {
      host.signalProcess(status.pid!, "SIGKILL");
      signalSent = true;
      const expected: DaemonProcessRecord = {
        pid: status.pid!,
        ppid: 0,
        command: status.entryScript ?? "",
        startedAt: status.processStartedAt ?? status.startedAt,
        processGenerationToken: recordedProcessGenerationToken(status),
      };
      const waitResult = await host.waitForStop(
        status.pid!,
        DAEMON_FORCED_STOP_TIMEOUT_MS,
        expected,
      );
      replacedByOtherGeneration = waitResult.replacedByOtherGeneration;
      if (!waitResult.stopped) {
        throw new ActionableError(
          `Acceptance-session restart daemon process ${status.pid} did not exit after SIGKILL.`,
        );
      }
    }
  } catch (error) {
    primaryError = error;
    if (restartToken && !signalSent) {
      await rollbackAcceptanceRestartAdmission(host, client, status, restartToken);
    }
    throw error;
  } finally {
    await closeAcceptanceRestartClient(host, client, primaryError);
  }
  await host.cleanupAcceptanceRestartFiles(status, replacedByOtherGeneration);
  await host.sleep(DAEMON_RESTART_HANDOFF_DELAY_MS);
  return restartResultFromStart(
    await host.startUnlocked(
      { ...daemonProcessOptions(status.options), strictPort: true },
      undefined,
      false,
    ),
  );
}

export async function requestAcceptanceRestartAdmission(
  host: DaemonRestartHost,
  client: DaemonClientLike,
  status: DaemonStatus,
  generation: DaemonGenerationIdentity,
  scope: AcceptanceSessionRestartScope,
  startupSecret: string,
): Promise<string> {
  const result: unknown = await client.callDaemonMethod(DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD, {
    ...status,
    scope,
    acceptanceCapability: createDaemonLiveAcceptanceScopedCapability(
      startupSecret,
      generation,
      scope,
    ),
  });
  const admission = result as Partial<DaemonAcceptanceSessionRestart> | null;
  if (admission?.accepted !== true) {
    throw new ActionableError(
      `Daemon declined the acceptance-session restart (${admission?.reason ?? "unknown"}).`,
    );
  }
  if (!admission.restartToken) {
    throw new ActionableError(
      "Daemon accepted the acceptance-session restart without a rollback token.",
    );
  }
  return admission.restartToken;
}

export async function commitAcceptanceRestartAdmission(
  host: DaemonRestartHost,
  client: DaemonClientLike,
  status: DaemonStatus,
  restartToken: string,
): Promise<void> {
  const result: unknown = await client.callDaemonMethod(DAEMON_COMMIT_ACCEPTANCE_RESTART_METHOD, {
    ...status,
    restartToken,
  });
  if ((result as Partial<DaemonAcceptanceRestartCommit> | null)?.committed !== true) {
    throw new ActionableError(
      "Daemon acceptance-session restart admission expired before it could be committed.",
    );
  }
}

export async function rollbackAcceptanceRestartAdmission(
  host: DaemonRestartHost,
  client: DaemonClientLike,
  status: DaemonStatus,
  restartToken: string,
): Promise<void> {
  try {
    await client.callDaemonMethod(DAEMON_RELEASE_ACCEPTANCE_RESTART_METHOD, {
      ...status,
      restartToken,
    });
  } catch (rollbackError) {
    logger.warn(
      `Failed to explicitly roll back acceptance restart admission: ${errorMessage(rollbackError)}`,
    );
  }
}

export async function closeAcceptanceRestartClient(
  host: DaemonRestartHost,
  client: DaemonClientLike,
  primaryError: unknown,
): Promise<void> {
  try {
    await client.close();
  } catch (closeError) {
    if (primaryError === undefined) {
      throw closeError;
    }
    logger.warn(
      `Failed to close acceptance restart control client after primary failure: ${errorMessage(closeError)}`,
    );
  }
}

/**
 * Revalidate the OS process generation immediately before an acceptance-only
 * SIGKILL. Admission authenticates the daemon that handled the RPC, but that
 * generation may exit before this manager signals its formerly owned PID.
 */
export async function verifyAcceptanceGenerationBeforeSignal(
  host: DaemonRestartHost,
  status: DaemonStatus,
  generation: DaemonGenerationIdentity,
): Promise<boolean> {
  return host.verifyDaemonGenerationBeforeSignal(
    {
      pid: generation.pid,
      ppid: 0,
      command: "",
      startedAt: status.processStartedAt ?? generation.startedAt,
      processGenerationToken: generation.processGenerationToken,
    },
    undefined,
    "Live acceptance",
  );
}
