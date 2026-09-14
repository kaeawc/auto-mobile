/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DaemonMcpProxy } from "../daemon/daemonMcpProxy";
import { getDaemonHealthReport, type DaemonHealthReport } from "../daemon/debugTools";
import { DaemonManager, type DaemonRestartResult } from "../daemon/manager";
import type { DaemonOptions } from "../daemon/types";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

const DEFAULT_DAEMON_RECOVERY_TIMEOUT_MS = 45_000;

export type DaemonRecoveryPhase = "diagnosis" | "recovery" | "verification" | "complete";
export type DaemonRecoveryAction = "joined" | "restarted";

export interface DoctorRepairOptions {
  /**
   * Total deadline across daemon diagnosis, repair, and verification.
   * It is intentionally independent of platform selection: the daemon and its
   * control socket are shared host infrastructure.
   */
  timeoutMs?: number;
  /** Daemon options parsed from the current CLI invocation. */
  daemonOptions?: DaemonOptions;
}

export interface DaemonRecoveryResult {
  status: "repaired" | "failed";
  phase: DaemonRecoveryPhase;
  before?: DaemonHealthReport;
  action: DaemonRecoveryAction;
  after?: DaemonHealthReport;
  nextAction?: string;
}

export interface DaemonRecoveryDependencies {
  getHealthReport?: () => Promise<DaemonHealthReport>;
  /**
   * This is the deliberate recovery escalation. DaemonManager acquires the
   * lifecycle lock, rechecks protocol ownership, then stops only verified
   * daemon-mode processes before starting a strict-port replacement.
   */
  recoverControlState?: (
    daemonOptions: DaemonOptions,
    isProtocolHealthy: () => Promise<boolean>,
  ) => Promise<DaemonRestartResult>;
  /**
   * A successful MCP tools/list round trip verifies the socket protocol and,
   * through DaemonMcpProxy, the daemon's version and build identity.
   */
  verifyProtocol?: () => Promise<void>;
  timer?: Timer;
}

class DaemonRecoveryDeadlineError extends Error {
  constructor(readonly phase: Exclude<DaemonRecoveryPhase, "complete">) {
    super(`Daemon recovery deadline elapsed during ${phase}`);
    this.name = "DaemonRecoveryDeadlineError";
  }
}

async function verifyDaemonProtocol(): Promise<void> {
  // Verification must not reconcile identity itself; explicit repair owns all
  // mutation so its deadline waits for a replacement to settle.
  const proxy = new DaemonMcpProxy({ autoStartDaemon: false });
  try {
    await proxy.listTools();
  } finally {
    await proxy.close();
  }
}

function protocolHealthProbe(verifyProtocol: () => Promise<void>): () => Promise<boolean> {
  return async () => {
    try {
      await verifyProtocol();
      return true;
    } catch (error) {
      // A failed compatibility probe is the explicit repair precondition.
      logger.debug(`Daemon repair compatibility probe failed: ${errorMessage(error)}`);
      return false;
    }
  };
}

async function withDeadline<T>(
  phase: Exclude<DaemonRecoveryPhase, "complete">,
  deadline: number,
  timer: Timer,
  operation: () => Promise<T>,
  settleOnTimeout = false,
): Promise<T> {
  const remaining = deadline - timer.now();
  if (remaining <= 0) {
    throw new DaemonRecoveryDeadlineError(phase);
  }

  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = timer.setTimeout(() => reject(new DaemonRecoveryDeadlineError(phase)), remaining);
  });
  const task = operation();

  try {
    return await Promise.race([task, expired]);
  } catch (error) {
    if (settleOnTimeout && error instanceof DaemonRecoveryDeadlineError) {
      await task.catch(() => undefined);
    }
    throw error;
  } finally {
    if (timeout !== undefined) {
      timer.clearTimeout(timeout);
    }
  }
}

function failedRecovery(
  phase: Exclude<DaemonRecoveryPhase, "complete">,
  action: DaemonRecoveryAction,
  error: unknown,
  before?: DaemonHealthReport,
  after?: DaemonHealthReport,
): DaemonRecoveryResult {
  const message = errorMessage(error);
  const nextAction =
    error instanceof DaemonRecoveryDeadlineError
      ? `Recovery deadline elapsed during ${phase}. Retry doctor --repair when the host is less busy.`
      : phase === "recovery"
        ? `Daemon recovery could not start a usable daemon: ${message}. Verify the AutoMobile installation, then retry doctor --repair.`
        : phase === "verification"
          ? `Daemon recovery did not produce a usable daemon: ${message}. Retry doctor --repair; if it persists, inspect --daemon diagnostics.`
          : `Daemon diagnosis failed: ${message}. Retry doctor --repair.`;
  return { status: "failed", phase, before, action, after, nextAction };
}

function assertUsableHealth(report: DaemonHealthReport): void {
  if (!report.daemonRunning || !report.socketConnectable) {
    throw new Error("daemon is not running and serving the control socket");
  }
}

type RecoveryAttempt<T> = { ok: true; value: T } | { ok: false; error: unknown };
type ProtocolRecoveryAttempt =
  | { ok: true; value: DaemonRecoveryAction }
  | {
      ok: false;
      phase: "recovery" | "verification";
      action: DaemonRecoveryAction;
      error: unknown;
    };
type FinalHealthAttempt =
  | { ok: true; value: DaemonHealthReport }
  | { ok: false; error: unknown; after?: DaemonHealthReport };

interface ResolvedRecoveryDependencies {
  timer: Timer;
  getHealthReport: () => Promise<DaemonHealthReport>;
  recoverControlState: (
    daemonOptions: DaemonOptions,
    isProtocolHealthy: () => Promise<boolean>,
  ) => Promise<DaemonRestartResult>;
  verifyProtocol: () => Promise<void>;
  isProtocolHealthy: () => Promise<boolean>;
}

function resolveRecoveryDependencies(
  dependencies: DaemonRecoveryDependencies,
): ResolvedRecoveryDependencies {
  const verifyProtocol = dependencies.verifyProtocol ?? verifyDaemonProtocol;
  return {
    timer: dependencies.timer ?? defaultTimer,
    getHealthReport: dependencies.getHealthReport ?? getDaemonHealthReport,
    recoverControlState:
      dependencies.recoverControlState ??
      ((daemonOptions, isProtocolHealthy) =>
        new DaemonManager().recoverControlState(daemonOptions, isProtocolHealthy)),
    verifyProtocol,
    isProtocolHealthy: protocolHealthProbe(verifyProtocol),
  };
}

async function attemptRecoveryStep<T>(
  phase: Exclude<DaemonRecoveryPhase, "complete">,
  deadline: number,
  timer: Timer,
  operation: () => Promise<T>,
  settleOnTimeout = false,
): Promise<RecoveryAttempt<T>> {
  try {
    return {
      ok: true,
      value: await withDeadline(phase, deadline, timer, operation, settleOnTimeout),
    };
  } catch (error) {
    return { ok: false, error };
  }
}

async function recoverUnusableSocket(
  before: DaemonHealthReport,
  deadline: number,
  timer: Timer,
  recoverControlState: (
    daemonOptions: DaemonOptions,
    isProtocolHealthy: () => Promise<boolean>,
  ) => Promise<DaemonRestartResult>,
  daemonOptions: DaemonOptions,
  isProtocolHealthy: () => Promise<boolean>,
): Promise<RecoveryAttempt<DaemonRecoveryAction>> {
  if (before.socketConnectable) {
    return { ok: true, value: "joined" };
  }
  return await attemptRecoveryStep(
    "recovery",
    deadline,
    timer,
    () => recoverControlState(daemonOptions, isProtocolHealthy),
    true,
  );
}

async function verifyProtocolWithRecovery(
  initialAction: DaemonRecoveryAction,
  deadline: number,
  timer: Timer,
  recoverControlState: (
    daemonOptions: DaemonOptions,
    isProtocolHealthy: () => Promise<boolean>,
  ) => Promise<DaemonRestartResult>,
  daemonOptions: DaemonOptions,
  isProtocolHealthy: () => Promise<boolean>,
  verifyProtocol: () => Promise<void>,
): Promise<ProtocolRecoveryAttempt> {
  const initialVerification = await attemptRecoveryStep(
    "verification",
    deadline,
    timer,
    verifyProtocol,
  );
  if (initialVerification.ok || initialAction === "restarted") {
    return initialVerification.ok
      ? { ok: true, value: initialAction }
      : {
          ok: false,
          phase: "verification",
          action: initialAction,
          error: initialVerification.error,
        };
  }

  const restartResult = await attemptRecoveryStep(
    "recovery",
    deadline,
    timer,
    () => recoverControlState(daemonOptions, isProtocolHealthy),
    true,
  );
  if (!restartResult.ok) {
    return { ok: false, phase: "recovery", action: initialAction, error: restartResult.error };
  }
  const replacementVerification = await attemptRecoveryStep(
    "verification",
    deadline,
    timer,
    verifyProtocol,
  );
  return replacementVerification.ok
    ? { ok: true, value: restartResult.value }
    : {
        ok: false,
        phase: "verification",
        action: restartResult.value,
        error: replacementVerification.error,
      };
}

async function verifyFinalHealth(
  deadline: number,
  timer: Timer,
  getHealthReport: () => Promise<DaemonHealthReport>,
): Promise<FinalHealthAttempt> {
  const health = await attemptRecoveryStep("verification", deadline, timer, getHealthReport);
  if (!health.ok) {
    return { ok: false, error: health.error };
  }
  try {
    assertUsableHealth(health.value);
    return health;
  } catch (error) {
    return { ok: false, error, after: health.value };
  }
}

/**
 * Deliberately repair only the shared daemon/control-socket layer. Device
 * selection is intentionally outside this contract: doctor currently accepts
 * platform filters, not a concrete AVD or simulator UUID.
 */
export async function repairDaemon(
  options: DoctorRepairOptions = {},
  dependencies: DaemonRecoveryDependencies = {},
): Promise<DaemonRecoveryResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DAEMON_RECOVERY_TIMEOUT_MS;
  const action: DaemonRecoveryAction = "joined";
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return failedRecovery(
      "diagnosis",
      action,
      new Error("recovery timeout must be a positive finite number"),
    );
  }

  const { timer, getHealthReport, recoverControlState, verifyProtocol, isProtocolHealthy } =
    resolveRecoveryDependencies(dependencies);
  const daemonOptions = options.daemonOptions ?? {};
  const deadline = timer.now() + timeoutMs;
  const diagnosis = await attemptRecoveryStep("diagnosis", deadline, timer, getHealthReport);
  if (!diagnosis.ok) {
    return failedRecovery("diagnosis", action, diagnosis.error);
  }
  const before = diagnosis.value;

  const socketRecovery = await recoverUnusableSocket(
    before,
    deadline,
    timer,
    recoverControlState,
    daemonOptions,
    isProtocolHealthy,
  );
  if (!socketRecovery.ok) {
    return failedRecovery("recovery", action, socketRecovery.error, before);
  }

  // A socket can accept a raw connection but belong to an incompatible or stale
  // daemon. One explicit restart hands stale-socket cleanup to the lifecycle
  // owner; it never unlinks a pathname from this diagnostic path.
  const protocolRecovery = await verifyProtocolWithRecovery(
    socketRecovery.value,
    deadline,
    timer,
    recoverControlState,
    daemonOptions,
    isProtocolHealthy,
    verifyProtocol,
  );
  if (!protocolRecovery.ok) {
    return failedRecovery(
      protocolRecovery.phase,
      protocolRecovery.action,
      protocolRecovery.error,
      before,
    );
  }

  const finalHealth = await verifyFinalHealth(deadline, timer, getHealthReport);
  if (!finalHealth.ok) {
    return failedRecovery(
      "verification",
      protocolRecovery.value,
      finalHealth.error,
      before,
      finalHealth.after,
    );
  }

  return {
    status: "repaired",
    phase: "complete",
    before,
    action: protocolRecovery.value,
    after: finalHealth.value,
  };
}
