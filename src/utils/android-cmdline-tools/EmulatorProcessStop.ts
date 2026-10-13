import { ActionableError } from "../../models/ActionableError";
import { isAndroidEmulatorSerial } from "../androidSerial";
import { exponentialBackoff } from "../Backoff";
import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import { raceWithDeadline } from "../raceWithDeadline";
import type { Timer } from "../SystemTimer";

/** Structurally the same as boot admission's AndroidProcessRow. */
export interface EmulatorHostProcessRow {
  pid: number;
  ppid: number;
  command: string;
}
export interface EmulatorProcessTableSource {
  read(options: {
    signal?: AbortSignal;
    deadlineMs?: number;
  }): Promise<{ value?: EmulatorHostProcessRow[]; error?: string }>;
}
export interface EmulatorProcessSignaler {
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  isRunning(pid: number): boolean;
}
type Candidate = { pid: number; command: string };
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
  | { kind: "still-running"; pid: number; command: string }
  | { kind: "identity-mismatch"; pid: number; runningAvdName: string }
  | {
      kind: "unidentified";
      identity: Extract<EmulatorProcessIdentity, { kind: "absent" | "ambiguous" | "unreadable" }>;
    };
export interface EmulatorProcessStopper {
  identify(target: StopTarget, options: StopOptions): Promise<EmulatorProcessIdentity>;
  /** Diagnostic only. These candidates are never authorization to signal. */
  describeSerial(serial: string, options: StopOptions): Promise<Candidate[]>;
  stop(target: StopTarget, options: StopOptions): Promise<EmulatorProcessStopOutcome>;
}

export const EMULATOR_TERM_GRACE_MS = 15_000;
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
  return name.startsWith("qemu-system-");
}

export function isSafeEmulatorProcessPid(pid: number, ownPid = process.pid): boolean {
  return Number.isInteger(pid) && pid > 1 && pid !== ownPid;
}

function serialPort(serial: string): number | undefined {
  return isAndroidEmulatorSerial(serial) ? Number(serial.slice("emulator-".length)) : undefined;
}

/** ps has no quoting; only whitespace-free AVD names and explicit ports prove identity. */
function processArguments(command: string): { avdName?: string; port?: number } {
  const args = command.split(/\s+/);
  const avdIndex = args.indexOf("-avd");
  const avdName =
    avdIndex >= 0 ? args[avdIndex + 1] : args.find((arg) => arg.startsWith("@"))?.slice(1);
  const ports = args.flatMap((arg, index) => {
    if (arg === "-port" || arg === "-ports") {
      return [args[index + 1]?.split(",")[0]];
    }
    const inline = /^-ports?=(.*)$/.exec(arg);
    return inline ? [inline[1].split(",")[0]] : [];
  });
  const port = ports.length === 1 && /^\d+$/.test(ports[0] ?? "") ? Number(ports[0]) : undefined;
  return { avdName: avdName && !avdName.startsWith("-") ? avdName : undefined, port };
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
          processArguments(row.command).port === port,
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
  const { avdName, port } = processArguments(row.command);
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

/** Keep diagnostics short rather than printing the complete ps command. */
export function emulatorProcessEscapeHint(
  serial: string,
  candidates: Candidate[] = [],
  tableStatus?: "absent" | "unreadable",
): string {
  if (candidates.length > 0) {
    const descriptions = candidates.map(({ pid, command }) => {
      const executable = command.match(/qemu-system-[^/\s]+/)?.[0] ?? "qemu-system-*";
      const { avdName, port } = processArguments(command);
      return `process ${pid} (\`${executable}${avdName ? ` -avd ${avdName}` : ""} -port ${port}\`); \`kill ${pid}\``;
    });
    return `Stop it by hand after checking its identity: ${descriptions.join("; ")} stops it even when the console does not answer (\`adb -s ${serial} emu kill\` goes through the same console).`;
  }
  const detail =
    tableStatus === "absent"
      ? "The process table has no emulator candidate with this explicit port."
      : tableStatus === "unreadable"
        ? "The process table could not be read."
        : "No process table was consulted.";
  return `${detail} Find and check it with \`ps -axo pid=,command= | grep -- '-port ${serialPort(serial) ?? "<port>"}'\`, then use \`kill <pid>\`. Use \`adb -s ${serial} emu kill\` only if the console answers.`;
}

const STOP_DISPATCHED = Symbol("emulatorStopDispatched");

/** A stop reached the console or signaler; a late exit must remain intentional. */
export class EmulatorStopDispatchedError extends ActionableError {}

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

export class EmulatorStillRunningError extends EmulatorStopDispatchedError {
  constructor(
    readonly pid: number,
    readonly serial: string,
    readonly avdName: string,
    command: string,
  ) {
    super(
      `Emulator '${serial}' (AVD '${avdName}') is still running with pid ${pid}. ${emulatorProcessEscapeHint(serial, [{ pid, command }])}`,
    );
  }
}

export class ProcessTableEmulatorProcessStopper implements EmulatorProcessStopper {
  constructor(
    private readonly table: EmulatorProcessTableSource,
    private readonly signaler: EmulatorProcessSignaler,
    private readonly timer: Timer,
    private readonly options: { ownPid?: number } = {},
  ) {}

  async identify(target: StopTarget, options: StopOptions): Promise<EmulatorProcessIdentity> {
    const result = await this.read(options);
    return result.value
      ? identifyRows(result.value, target, this.options.ownPid ?? process.pid)
      : { kind: "unreadable", detail: result.error ?? "Process table unavailable" };
  }

  async describeSerial(serial: string, options: StopOptions): Promise<Candidate[]> {
    const result = await this.read(options);
    return candidatesForSerial(result.value ?? [], serial, this.options.ownPid ?? process.pid).map(
      ({ pid, command }) => ({
        pid,
        command,
      }),
    );
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
      return this.stillRunning(identity);
    }
    // Between the ps snapshot and kill(2), a pid can exit and be reused. macOS has no
    // pidfd to close that window; send TERM immediately after the one table read.
    const term = this.send(identity, "SIGTERM");
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
    );
    if (exited) {
      return { kind: "stopped", pid: identity.pid, signal: "SIGTERM" };
    }
    return this.escalate(target, identity, stopOptions);
  }

  private async escalate(
    target: StopTarget,
    identity: Extract<EmulatorProcessIdentity, { kind: "match" }>,
    options: StopOptions,
  ): Promise<EmulatorProcessStopOutcome> {
    if (!this.hasKillWaitBudget(identity.pid, options.deadlineMs)) {
      return this.stillRunning(identity);
    }
    const result = await this.read(options);
    if (!result.value) {
      return this.stillRunning(identity);
    }
    const row = result.value.find(({ pid }) => pid === identity.pid);
    if (!row || row.command !== identity.command) {
      logger.warn(
        `[EmulatorProcessStop] pid ${identity.pid} disappeared or changed arguments before SIGKILL; leaving its replacement untouched`,
      );
      return { kind: "stopped", pid: identity.pid, signal: "SIGTERM" };
    }
    const current = identifyRows(result.value, target, this.options.ownPid ?? process.pid);
    options.signal?.throwIfAborted();
    if (current.kind !== "match" || current.pid !== identity.pid) {
      return this.stillRunning(identity);
    }
    if (!this.hasKillWaitBudget(identity.pid, options.deadlineMs)) {
      return this.stillRunning(identity);
    }
    const kill = this.send(identity, "SIGKILL");
    if (kill) {
      return kill;
    }
    return (await this.waitForExit(
      identity.pid,
      Math.min(options.deadlineMs, this.timer.now() + EMULATOR_KILL_WAIT_MS),
      options.signal,
    ))
      ? { kind: "stopped", pid: identity.pid, signal: "SIGKILL" }
      : this.stillRunning(identity);
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

  private stillRunning(identity: Candidate): EmulatorProcessStopOutcome {
    return { kind: "still-running", pid: identity.pid, command: identity.command };
  }

  private send(
    identity: Candidate,
    signal: "SIGTERM" | "SIGKILL",
  ): EmulatorProcessStopOutcome | undefined {
    try {
      this.signaler.signal(identity.pid, signal);
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
      return this.stillRunning(identity);
    }
    return undefined;
  }

  private async waitForExit(
    pid: number,
    deadlineMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      if (!this.signaler.isRunning(pid)) {
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
  ): Promise<{ value?: EmulatorHostProcessRow[]; error?: string }> {
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
