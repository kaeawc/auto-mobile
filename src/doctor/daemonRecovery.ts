/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DaemonMcpProxy } from "../daemon/daemonMcpProxy";
import { getDaemonHealthReport, type DaemonHealthReport } from "../daemon/debugTools";
import { DaemonManager, type DaemonRestartResult } from "../daemon/manager";
import { errorMessage } from "../utils/describeUnknownError";
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
  recoverControlState?: () => Promise<DaemonRestartResult>;
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
  const proxy = new DaemonMcpProxy();
  try {
    await proxy.listTools();
  } finally {
    await proxy.close();
  }
}

async function withDeadline<T>(
  phase: Exclude<DaemonRecoveryPhase, "complete">,
  deadline: number,
  timer: Timer,
  operation: () => Promise<T>,
): Promise<T> {
  const remaining = deadline - timer.now();
  if (remaining <= 0) {
    throw new DaemonRecoveryDeadlineError(phase);
  }

  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = timer.setTimeout(() => reject(new DaemonRecoveryDeadlineError(phase)), remaining);
  });

  try {
    return await Promise.race([operation(), expired]);
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
  | { ok: false; phase: "recovery" | "verification"; error: unknown };
type FinalHealthAttempt =
  | { ok: true; value: DaemonHealthReport }
  | { ok: false; error: unknown; after?: DaemonHealthReport };

interface ResolvedRecoveryDependencies {
  timer: Timer;
  getHealthReport: () => Promise<DaemonHealthReport>;
  recoverControlState: () => Promise<DaemonRestartResult>;
  verifyProtocol: () => Promise<void>;
}

function resolveRecoveryDependencies(
  dependencies: DaemonRecoveryDependencies,
): ResolvedRecoveryDependencies {
  return {
    timer: dependencies.timer ?? defaultTimer,
    getHealthReport: dependencies.getHealthReport ?? getDaemonHealthReport,
    recoverControlState:
      dependencies.recoverControlState ?? (() => new DaemonManager().recoverControlState()),
    verifyProtocol: dependencies.verifyProtocol ?? verifyDaemonProtocol,
  };
}

async function attemptRecoveryStep<T>(
  phase: Exclude<DaemonRecoveryPhase, "complete">,
  deadline: number,
  timer: Timer,
  operation: () => Promise<T>,
): Promise<RecoveryAttempt<T>> {
  try {
    return { ok: true, value: await withDeadline(phase, deadline, timer, operation) };
  } catch (error) {
    return { ok: false, error };
  }
}

async function recoverUnusableSocket(
  before: DaemonHealthReport,
  deadline: number,
  timer: Timer,
  recoverControlState: () => Promise<DaemonRestartResult>,
): Promise<RecoveryAttempt<DaemonRecoveryAction>> {
  if (before.socketConnectable) {
    return { ok: true, value: "joined" };
  }
  return await attemptRecoveryStep("recovery", deadline, timer, recoverControlState);
}

async function verifyProtocolWithRecovery(
  initialAction: DaemonRecoveryAction,
  deadline: number,
  timer: Timer,
  recoverControlState: () => Promise<DaemonRestartResult>,
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
      : { ok: false, phase: "verification", error: initialVerification.error };
  }

  const restartResult = await attemptRecoveryStep("recovery", deadline, timer, recoverControlState);
  if (!restartResult.ok) {
    return { ok: false, phase: "recovery", error: restartResult.error };
  }
  const replacementVerification = await attemptRecoveryStep(
    "verification",
    deadline,
    timer,
    verifyProtocol,
  );
  return replacementVerification.ok
    ? { ok: true, value: restartResult.value }
    : { ok: false, phase: "verification", error: replacementVerification.error };
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

  const { timer, getHealthReport, recoverControlState, verifyProtocol } =
    resolveRecoveryDependencies(dependencies);
  const deadline = timer.now() + timeoutMs;
  const diagnosis = await attemptRecoveryStep("diagnosis", deadline, timer, getHealthReport);
  if (!diagnosis.ok) {
    return failedRecovery("diagnosis", action, diagnosis.error);
  }
  const before = diagnosis.value;

  const socketRecovery = await recoverUnusableSocket(before, deadline, timer, recoverControlState);
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
    verifyProtocol,
  );
  if (!protocolRecovery.ok) {
    return failedRecovery(
      protocolRecovery.phase,
      socketRecovery.value,
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
