import type { ProcessTableFailure } from "../../devices/bootAdmission/processTableRetry";
import { exponentialBackoff } from "../Backoff";
import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import { raceWithDeadline } from "../raceWithDeadline";
import type { Timer } from "../SystemTimer";
import type { LockOwnerGenerationProbe } from "../fileLock";
import { EmulatorStopDispatchedError } from "./EmulatorStopDispatchedError";
import { emulatorProcessArguments, serialPort } from "./EmulatorStillRunningError";
export {
  EmulatorStillRunningError,
  serialPort,
  emulatorProcessArguments,
  emulatorProcessEscapeHint,
} from "./EmulatorStillRunningError";

/** Structurally the same as boot admission's AndroidProcessRow. */
export interface EmulatorHostProcessRow {
  pid: number;
  ppid: number;
  command: string;
}
export interface EmulatorProcessTableSource {
  read(options: { signal?: AbortSignal; deadlineMs?: number }): Promise<{
    value?: EmulatorHostProcessRow[];
    /** Readable rows are a count floor, not a complete inventory. */
    incomplete?: boolean;
    error?: string;
    failure?: ProcessTableFailure;
  }>;
}
export type EmulatorGroupProbe =
  | { kind: "own-group"; pgid: number }
  | { kind: "shared" }
  | { kind: "absent" }
  | { kind: "unproven" };
export interface EmulatorProcessSignaler {
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  isRunning(pid: number): boolean;
  /** Distinguish a proven separate group, a shared group, and a gone or unproven process. */
  resolveOwnGroup?(
    identity: { pid: number; command: string },
    options: { signal?: AbortSignal; deadlineMs: number },
  ): Promise<EmulatorGroupProbe>;
  signalGroup?(pgid: number, signal: "SIGTERM" | "SIGKILL"): void;
}
export type Candidate = { pid: number; command: string };
type StopTarget = { serial: string; avdName: string };
type StopOptions = { deadlineMs: number; signal?: AbortSignal };
export type EmulatorProcessIdentity =
  | { kind: "match"; pid: number; avdName: string; port: number; command: string }
  | { kind: "mismatch"; pid: number; runningAvdName: string; port: number; command: string }
  | { kind: "absent" }
  | { kind: "ambiguous"; candidates: Candidate[] }
  | { kind: "unreadable"; detail: string };
export type EmulatorProcessStopOutcome =
  | { kind: "stopped"; pid: number; signal: "SIGTERM" | "SIGKILL" }
  | { kind: "still-running"; pid: number; command: string; signalled: boolean }
  | { kind: "identity-mismatch"; pid: number; runningAvdName: string }
  | {
      kind: "unidentified";
      identity: Extract<EmulatorProcessIdentity, { kind: "absent" | "ambiguous" | "unreadable" }>;
    };
/** Unsupported hosts may use other deletion witnesses; failed supported reads must fail closed. */
export type EmulatorSerialDescription =
  | { kind: "unsupported"; detail: string }
  | { kind: "read"; candidates: Candidate[] }
  | { kind: "unreadable"; detail: string };
export interface EmulatorProcessStopper {
  identify(target: StopTarget, options: StopOptions): Promise<EmulatorProcessIdentity>;
  /** Read-only deletion fence: includes AVD processes even without an explicit port. */
  describeAvd(avdName: string, options: StopOptions): Promise<EmulatorSerialDescription>;
  /** Diagnostic only. These candidates are never authorization to signal. */
  describeSerial(serial: string, options: StopOptions): Promise<EmulatorSerialDescription>;
  stop(target: StopTarget, options: StopOptions): Promise<EmulatorProcessStopOutcome>;
}

export const EMULATOR_TERM_GRACE_MS = 15_000;
export const EMULATOR_MIN_TERM_GRACE_MS = 5_000;
export const EMULATOR_KILL_WAIT_MS = 1_000;
export const EMULATOR_STOP_RESULT_MARGIN_MS = 2_000;
const EXIT_BACKOFF = exponentialBackoff({ initialDelayMs: 50, maxDelayMs: 500 });
const SDK_QEMU_EXECUTABLE = /\/qemu\/[^/\s]+\/qemu-system-[^/\s]*(?:\s|$)/;

/** Shared with boot admission: tolerate unquoted SDK paths with spaces (#11588). */
export function isEmulatorQemuProcess(row: Pick<EmulatorHostProcessRow, "command">): boolean {
  const executable = row.command.split(" -")[0] ?? "";
  const name = executable.slice(executable.lastIndexOf("/") + 1).trim();
  return name.startsWith("qemu-system-") || SDK_QEMU_EXECUTABLE.test(row.command);
}

/** Signalling requires the command's own executable, never a wrapper's argument. */
export function isSignalableEmulatorQemuProcess(
  row: Pick<EmulatorHostProcessRow, "command">,
): boolean {
  const executable = row.command.split(" -")[0] ?? "";
  const name = executable.slice(executable.lastIndexOf("/") + 1).trim();
  return (
    (executable.startsWith("/") || !/\s/.test(executable)) &&
    !executable.includes(" /") &&
    name.startsWith("qemu-system-")
  );
}

export function isSafeEmulatorProcessPid(pid: number, ownPid = process.pid): boolean {
  return Number.isInteger(pid) && pid > 1 && pid !== ownPid;
}

function candidatesForSerial(
  rows: EmulatorHostProcessRow[],
  serial: string,
  ownPid: number,
): EmulatorHostProcessRow[] {
  const port = serialPort(serial);
  return port === undefined
    ? []
    : rows.filter(
        (row) =>
          isSafeEmulatorProcessPid(row.pid, ownPid) &&
          isSignalableEmulatorQemuProcess(row) &&
          emulatorProcessArguments(row.command).port === port,
      );
}

function identifyRows(
  rows: EmulatorHostProcessRow[],
  target: StopTarget,
  ownPid: number,
): EmulatorProcessIdentity {
  const candidates = candidatesForSerial(rows, target.serial, ownPid);
  if (candidates.length === 0) {
    return { kind: "absent" };
  }
  const row = candidates[0];
  const { avdName, port } = emulatorProcessArguments(row.command);
  if (candidates.length !== 1 || !avdName || port === undefined) {
    return {
      kind: "ambiguous",
      candidates: candidates.map(({ pid, command }) => ({ pid, command })),
    };
  }
  return avdName === target.avdName
    ? { kind: "match", pid: row.pid, avdName, port, command: row.command }
    : { kind: "mismatch", pid: row.pid, runningAvdName: avdName, port, command: row.command };
}

const STOP_DISPATCHED = Symbol("emulatorStopDispatched");

/** Preserve adb's timeout type while attaching the dispatched-stop classification. */
export function markEmulatorStopDispatched<T extends Error>(error: T): T {
  return Object.assign(error, { [STOP_DISPATCHED]: true });
}

export function isEmulatorStopDispatchedError(error: unknown): boolean {
  return (
    error instanceof EmulatorStopDispatchedError ||
    (error instanceof Error && STOP_DISPATCHED in error)
  );
}

export class ProcessTableEmulatorProcessStopper implements EmulatorProcessStopper {
  constructor(
    private readonly table: EmulatorProcessTableSource,
    private readonly signaler: EmulatorProcessSignaler,
    private readonly timer: Timer,
    private readonly options: {
      ownPid?: number;
      processGeneration?: LockOwnerGenerationProbe;
    } = {},
  ) {}

  async identify(target: StopTarget, options: StopOptions): Promise<EmulatorProcessIdentity> {
    const result = await this.read(options);
    return result.value
      ? identifyRows(result.value, target, this.options.ownPid ?? process.pid)
      : { kind: "unreadable", detail: result.error ?? "Process table unavailable" };
  }

  async describeSerial(serial: string, options: StopOptions): Promise<EmulatorSerialDescription> {
    const result = await this.read(options);
    if (!result.value) {
      return { kind: "unreadable", detail: result.error ?? "Process table unavailable" };
    }
    return {
      kind: "read",
      candidates: candidatesForSerial(result.value, serial, this.options.ownPid ?? process.pid).map(
        ({ pid, command }) => ({ pid, command }),
      ),
    };
  }

  async describeAvd(avdName: string, options: StopOptions): Promise<EmulatorSerialDescription> {
    const result = await this.read(options);
    if (result.failure?.reason === "unsupported-platform") {
      return { kind: "unsupported", detail: result.failure.detail };
    }
    if (!result.value) {
      return { kind: "unreadable", detail: result.error ?? "Process table unavailable" };
    }
    return {
      kind: "read",
      candidates: result.value
        .filter(
          (row) =>
            isEmulatorQemuProcess(row) && emulatorProcessArguments(row.command).avdName === avdName,
        )
        .map(({ pid, command }) => ({ pid, command })),
    };
  }

  async stop(target: StopTarget, options: StopOptions): Promise<EmulatorProcessStopOutcome> {
    const stopOptions = {
      ...options,
      deadlineMs: options.deadlineMs - EMULATOR_STOP_RESULT_MARGIN_MS,
    };
    const identity = await this.identify(target, stopOptions);
    if (identity.kind === "mismatch") {
      return {
        kind: "identity-mismatch",
        pid: identity.pid,
        runningAvdName: identity.runningAvdName,
      };
    }
    if (identity.kind !== "match") {
      return { kind: "unidentified", identity };
    }
    options.signal?.throwIfAborted();
    if (this.timer.now() >= options.deadlineMs) {
      return this.stillRunning(identity, false);
    }
    const probe = await this.resolveOwnGroup(identity, stopOptions);
    options.signal?.throwIfAborted();
    if (probe.kind === "absent") {
      logger.warn(
        `[EmulatorProcessStop] pid ${identity.pid} disappeared or changed command before SIGTERM; leaving its replacement untouched`,
      );
      return { kind: "stopped", pid: identity.pid, signal: "SIGTERM" };
    }
    const group = probe.kind === "own-group" ? probe.pgid : undefined;
    // A pid can exit and be reused; send TERM immediately after the single group probe.
    const termSentAt = this.timer.now();
    // The ps snapshot -> capture window remains (no pidfd on macOS), but the
    // in-process generation capture is sub-millisecond; send TERM immediately after it.
    const token = this.options.processGeneration?.current(identity.pid);
    const term = this.send(identity, "SIGTERM", group);
    if (term) {
      return term;
    }
    const exited = await this.waitForExit(
      identity.pid,
      Math.min(
        stopOptions.deadlineMs - EMULATOR_KILL_WAIT_MS,
        this.timer.now() + EMULATOR_TERM_GRACE_MS,
      ),
      options.signal,
      token,
    );
    if (exited) {
      return { kind: "stopped", pid: identity.pid, signal: "SIGTERM" };
    }
    if (this.timer.now() - termSentAt < EMULATOR_MIN_TERM_GRACE_MS) {
      logger.warn(
        `[EmulatorProcessStop] SIGKILL withheld for pid ${identity.pid}: SIGTERM grace was shorter than ${EMULATOR_MIN_TERM_GRACE_MS}ms`,
      );
      return this.stillRunning(identity);
    }
    return this.escalate(target, identity, stopOptions, { token, group });
  }

  private async resolveOwnGroup(
    identity: Candidate,
    options: StopOptions,
  ): Promise<EmulatorGroupProbe> {
    if (!this.signaler.resolveOwnGroup) {
      logger.warn(
        `[EmulatorProcessStop] own group unproven for pid ${identity.pid}; signalling pid only`,
      );
      return { kind: "unproven" };
    }
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    try {
      const remainingMs = options.deadlineMs - this.timer.now();
      if (remainingMs <= 0) {
        throw new Error("Process group deadline already spent");
      }
      const group = await raceWithDeadline(
        () =>
          this.signaler.resolveOwnGroup!(
            { pid: identity.pid, command: identity.command },
            { ...options, signal },
          ),
        {
          timer: this.timer,
          signal: options.signal,
          timeoutMs: remainingMs,
          label: "Emulator own process group",
          onTimeout: () => controller.abort(),
        },
      );
      if (group.kind === "shared" || group.kind === "absent") {
        return group;
      }
      if (
        group.kind === "own-group" &&
        group.pgid === identity.pid &&
        group.pgid > 1 &&
        this.signaler.signalGroup
      ) {
        return group;
      }
      logger.warn(
        `[EmulatorProcessStop] own group unproven for pid ${identity.pid}; signalling pid only`,
      );
      return { kind: "unproven" };
    } catch (error) {
      options.signal?.throwIfAborted();
      logger.warn(
        `[EmulatorProcessStop] own group unavailable for pid ${identity.pid}; signalling pid only: ${errorMessage(error)}`,
        error,
      );
      return { kind: "unproven" };
    }
  }

  private async escalate(
    target: StopTarget,
    identity: Extract<EmulatorProcessIdentity, { kind: "match" }>,
    options: StopOptions,
    { token, group }: { token?: string; group?: number } = {},
  ): Promise<EmulatorProcessStopOutcome> {
    if (!this.hasKillWaitBudget(identity.pid, options.deadlineMs)) {
      return this.stillRunning(identity);
    }
    if (this.generationChanged(identity.pid, token)) {
      return this.replacementStopped(identity.pid);
    }
    const result = await this.read(options);
    if (!result.value) {
      return this.stillRunning(identity);
    }
    const row = result.value.find(({ pid }) => pid === identity.pid);
    if (!row || row.command !== identity.command) {
      return this.replacementStopped(identity.pid);
    }
    const current = identifyRows(result.value, target, this.options.ownPid ?? process.pid);
    options.signal?.throwIfAborted();
    if (current.kind !== "match" || current.pid !== identity.pid) {
      return this.stillRunning(identity);
    }
    return this.killAndWait(identity, options, token, group);
  }

  private async killAndWait(
    identity: Extract<EmulatorProcessIdentity, { kind: "match" }>,
    options: StopOptions,
    token: string | undefined,
    group?: number,
  ): Promise<EmulatorProcessStopOutcome> {
    if (!this.hasKillWaitBudget(identity.pid, options.deadlineMs)) {
      return this.stillRunning(identity);
    }
    if (this.generationChanged(identity.pid, token)) {
      return this.replacementStopped(identity.pid);
    }
    const kill = this.send(identity, "SIGKILL", group);
    if (kill) {
      return kill;
    }
    return (await this.waitForExit(
      identity.pid,
      Math.min(options.deadlineMs, this.timer.now() + EMULATOR_KILL_WAIT_MS),
      options.signal,
      token,
    ))
      ? { kind: "stopped", pid: identity.pid, signal: "SIGKILL" }
      : this.stillRunning(identity);
  }

  private generationChanged(pid: number, token: string | undefined): boolean {
    // Unreadable identity preserves PID-only behavior.
    return (
      token !== undefined && this.options.processGeneration?.compare(pid, token) === "different"
    );
  }

  private replacementStopped(pid: number): EmulatorProcessStopOutcome {
    logger.warn(
      `[EmulatorProcessStop] pid ${pid} disappeared or changed arguments before SIGKILL; leaving its replacement untouched`,
    );
    return { kind: "stopped", pid, signal: "SIGTERM" };
  }

  private hasKillWaitBudget(pid: number, deadlineMs: number): boolean {
    if (this.timer.now() < deadlineMs) {
      return true;
    }
    logger.warn(
      `[EmulatorProcessStop] no budget for SIGKILL wait for pid ${pid}; SIGTERM was sent`,
    );
    return false;
  }

  private stillRunning(identity: Candidate, signalled = true): EmulatorProcessStopOutcome {
    return { kind: "still-running", pid: identity.pid, command: identity.command, signalled };
  }

  private send(
    identity: Candidate,
    signal: "SIGTERM" | "SIGKILL",
    group?: number,
  ): EmulatorProcessStopOutcome | undefined {
    try {
      if (group !== undefined && this.signaler.signalGroup) {
        this.signaler.signalGroup(group, signal);
      } else {
        this.signaler.signal(identity.pid, signal);
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        // ESRCH proves this pid is gone; no additional signal is needed.
        logger.debug(`[EmulatorProcessStop] pid ${identity.pid} already exited`);
        return { kind: "stopped", pid: identity.pid, signal };
      }
      logger.warn(
        `[EmulatorProcessStop] ${signal} failed for pid ${identity.pid}: ${errorMessage(error)}`,
        error,
      );
      return this.stillRunning(identity, signal === "SIGKILL");
    }
    return undefined;
  }

  private async waitForExit(
    pid: number,
    deadlineMs: number,
    signal?: AbortSignal,
    token?: string,
  ): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      if (!this.signaler.isRunning(pid) || this.generationChanged(pid, token)) {
        return true;
      }
      const remainingMs = deadlineMs - this.timer.now();
      if (remainingMs <= 0) {
        return false;
      }
      await raceWithDeadline(
        () => this.timer.sleep(Math.min(remainingMs, EXIT_BACKOFF.delayForAttempt(attempt))),
        {
          timer: this.timer,
          signal,
          label: "Emulator process exit",
        },
      );
    }
  }

  private async read(
    options: StopOptions,
  ): Promise<{ value?: EmulatorHostProcessRow[]; error?: string; failure?: ProcessTableFailure }> {
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    try {
      const remainingMs = options.deadlineMs - this.timer.now();
      if (remainingMs <= 0) {
        throw new Error("Process table deadline already spent");
      }
      const result = await raceWithDeadline(() => this.table.read({ ...options, signal }), {
        timer: this.timer,
        signal: options.signal,
        timeoutMs: remainingMs,
        label: "Emulator process table",
        onTimeout: () => controller.abort(),
      });
      options.signal?.throwIfAborted();
      if (!result.value) {
        logger.warn(`[EmulatorProcessStop] process table unavailable: ${result.error}`);
      }
      return result;
    } catch (error) {
      options.signal?.throwIfAborted();
      logger.warn(`[EmulatorProcessStop] process table unavailable: ${errorMessage(error)}`, error);
      return { error: errorMessage(error) };
    }
  }
}
