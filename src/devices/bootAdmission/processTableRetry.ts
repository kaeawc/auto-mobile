import {
  exponentialBackoff,
  normalizeBackoff,
  type BackoffInput,
  type BackoffPolicy,
} from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import type { HostCommandExecutor } from "../../utils/HostCommandExecutor";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { readHostProcessTable } from "./readHostProcessTable";
import { wrapCommandError } from "../../utils/CommandError";
import { PS_SNAPSHOT_ARGS } from "./psSnapshot";
import { readProcProcessTable, type AndroidProcessRow, type ProcFs } from "./procProcessTable";

export type ProcessTableFailureReason =
  | "timeout"
  | "spawn-resources"
  | "exit"
  | "killed"
  | "not-found"
  | "denied"
  | "unsupported-flags"
  | "output-too-large"
  | "unparseable"
  | "unsupported-platform"
  | "unknown";

export interface ProcessTableFailure {
  reason: ProcessTableFailureReason;
  /** True for a load-related failure retried until its attempt or time budget ran out. */
  transient: boolean;
  /** ps invocations made (0 on a platform without ps). */
  attempts: number;
  /** First line of the last error, at most 200 characters. */
  detail: string;
}

export interface ProcessTableReadOptions {
  timer?: Timer;
  attemptTimeoutMs?: number;
  maxAttempts?: number;
  backoff?: BackoffInput;
  budgetMs?: number;
  processTableSupported?: boolean;
  procFs?: ProcFs;
  exitDeterministicAfterSamples?: number;
}

interface ProcessTableResult {
  value?: AndroidProcessRow[];
  error?: string;
  failure?: ProcessTableFailure;
}

const SPAWN_REASONS = new Map<string, ProcessTableFailureReason>([
  ["EAGAIN", "spawn-resources"],
  ["EMFILE", "spawn-resources"],
  ["ENFILE", "spawn-resources"],
  ["ENOMEM", "spawn-resources"],
  ["ENOENT", "not-found"],
  ["ENOTDIR", "not-found"],
  ["EACCES", "denied"],
  ["EPERM", "denied"],
  ["ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "output-too-large"],
]);
const TRANSIENT_REASONS = new Set<ProcessTableFailureReason>([
  "timeout",
  "spawn-resources",
  "exit",
  "killed",
]);
const DENIED = /operation not permitted|permission denied/i;
const USAGE_ERROR = /illegal option|invalid option|unrecognized option|usage:/i;
const MIN_RETRY_TIMEOUT_MS = 250;
export const DEFAULT_EXIT_DETERMINISTIC_AFTER_SAMPLES = 3;

function stderrText(stderr: unknown): string {
  return Buffer.isBuffer(stderr) ? stderr.toString() : typeof stderr === "string" ? stderr : "";
}

function exitReason(code: number, stderr: unknown): ProcessTableFailureReason {
  if (code === 0) {
    return "unknown";
  }
  const text = stderrText(stderr);
  if (code === 126 || DENIED.test(text)) {
    return "denied";
  }
  if (code === 127) {
    return "not-found";
  }
  return USAGE_ERROR.test(text) ? "unsupported-flags" : "exit";
}

function signalFailureReason(
  error: object,
  signal: string,
  code: unknown,
): ProcessTableFailureReason {
  return "killed" in error && error.killed === true && signal === "SIGTERM" && code === null
    ? "timeout"
    : "killed";
}

function rawFailureReason(error: object): ProcessTableFailureReason {
  const code = "code" in error ? error.code : undefined;
  if (typeof code === "string") {
    return SPAWN_REASONS.get(code) ?? "unknown";
  }
  if (typeof code === "number") {
    return exitReason(code, "stderr" in error ? error.stderr : undefined);
  }
  if ("signal" in error && typeof error.signal === "string") {
    return signalFailureReason(error, error.signal, code);
  }
  return /^(?:ps|\/proc) returned no parseable processes/.test(errorMessage(error))
    ? "unparseable"
    : "unknown";
}

function rawFailureDetail(
  error: object,
  reason: ProcessTableFailureReason,
  timeoutMs: number,
): string {
  if (reason === "timeout") {
    return `timed out after ${timeoutMs}ms`;
  }
  if (reason === "killed" && "signal" in error) {
    return `killed by ${String(error.signal)}`;
  }
  const code = "code" in error ? error.code : undefined;
  if (typeof code === "number") {
    const line = stderrText("stderr" in error ? error.stderr : undefined)
      .split(/\r?\n/)
      .find((value) => value.trim());
    return line ? `exit ${code}: ${line}` : `exit ${code}`;
  }
  const message = errorMessage(error);
  return typeof code === "string" ? `${code}: ${message}` : message;
}

/** ExecSeam preserves the raw exec error in cause, rather than copying its status fields. */
function classifyFailure(
  error: unknown,
  timeoutMs: number,
): Pick<ProcessTableFailure, "reason" | "detail"> {
  const seen = new Set<unknown>();
  let reason: ProcessTableFailureReason = "unknown";
  let detail = errorMessage(error);
  for (
    let current = error;
    typeof current === "object" && current !== null && !seen.has(current);
  ) {
    seen.add(current);
    if ("name" in current && current.name === "AbortError") {
      throw error;
    }
    const candidate = rawFailureReason(current);
    if (candidate !== "unknown") {
      reason = candidate;
      detail = rawFailureDetail(current, candidate, timeoutMs);
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return { reason, detail: detail.split(/\r?\n/, 1)[0].slice(0, 200) };
}

/** Bounded retries for the Android count only; iOS keeps its one-shot process read. */
export class ProcessTableReader {
  private readonly timer: Timer;
  private readonly attemptTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoff: BackoffPolicy;
  private readonly budgetMs: number;
  private readonly supported: boolean;
  private readonly warnedReasons = new Set<ProcessTableFailureReason>();
  private readonly warnedProcReasons = new Set<ProcessTableFailureReason>();

  private readonly procFs: ProcFs | undefined;
  private readonly exitDeterministicAfterSamples: number;
  private consecutiveExitSamples = 0;
  private exitLatched = false;
  private procLatched = false;

  constructor(
    private readonly executor: HostCommandExecutor,
    options: ProcessTableReadOptions = {},
  ) {
    this.timer = options.timer ?? defaultTimer;
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.backoff = normalizeBackoff(
      options.backoff ?? exponentialBackoff({ initialDelayMs: 100, maxDelayMs: 800 }),
    );
    this.budgetMs = options.budgetMs ?? 9_000;
    this.supported = options.processTableSupported ?? true;
    this.procFs = options.procFs;
    this.exitDeterministicAfterSamples =
      options.exitDeterministicAfterSamples ?? DEFAULT_EXIT_DETERMINISTIC_AFTER_SAMPLES;
  }

  async read(options: { signal?: AbortSignal; deadlineMs?: number }): Promise<ProcessTableResult> {
    try {
      return await this.readSupported(options);
    } catch (error) {
      this.consecutiveExitSamples = 0;
      // An aborted read breaks the consecutive-sample sequence; preserve its raw reason.
      logger.debug(`[BootAdmission] process table read cancelled: ${errorMessage(error)}`);
      throw error;
    }
  }

  private async readSupported(options: {
    signal?: AbortSignal;
    deadlineMs?: number;
  }): Promise<ProcessTableResult> {
    options.signal?.throwIfAborted();
    if (!this.supported) {
      return this.failed({
        reason: "unsupported-platform",
        transient: false,
        attempts: 0,
        detail: "Host platform has no ps process table",
      });
    }
    const endMs = options.deadlineMs ?? this.timer.now() + this.budgetMs;
    if (this.procLatched) {
      return this.readProc(options, endMs);
    }
    return this.readPs(options, endMs);
  }

  private async readPs(
    options: { signal?: AbortSignal },
    endMs: number,
  ): Promise<ProcessTableResult> {
    let retriedReason: ProcessTableFailureReason | undefined;
    for (let attempts = 1; ; attempts++) {
      options.signal?.throwIfAborted();
      // Keep the first read's full timeout so a short whole-sample race still fails closed.
      const timeoutMs =
        attempts === 1
          ? this.attemptTimeoutMs
          : Math.min(this.attemptTimeoutMs, endMs - this.timer.now());
      try {
        const value = await this.attempt(
          (signal) => readHostProcessTable(this.executor, { signal, timeoutMs }),
          timeoutMs,
          options.signal,
          "ps",
        );
        this.resetExitLatch();
        if (retriedReason) {
          logger.info(
            `[BootAdmission] emulator process snapshot succeeded on attempt ${attempts} after ${retriedReason}`,
          );
        }
        return { value };
      } catch (error) {
        options.signal?.throwIfAborted();
        const { reason, detail } = classifyFailure(error, timeoutMs);
        const transient = TRANSIENT_REASONS.has(reason) && !(reason === "exit" && this.exitLatched);
        const failure = {
          reason,
          transient,
          attempts,
          detail,
        };
        const delay = this.retryDelay(failure, endMs);
        if (delay === undefined) {
          return this.finishPsFailure(failure, error, options, endMs);
        }
        retriedReason = reason;
        // An aborted backoff never starts another ps in the background.
        await raceWithDeadline(() => this.timer.sleep(delay), {
          timer: this.timer,
          signal: options.signal,
          label: "Android process table retry backoff",
        });
        if (endMs - this.timer.now() < MIN_RETRY_TIMEOUT_MS) {
          return this.finishPsFailure(failure, error, options, endMs);
        }
      }
    }
  }

  private async attempt(
    read: (signal: AbortSignal) => Promise<AndroidProcessRow[]>,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
    label: "ps" | "/proc",
  ): Promise<AndroidProcessRow[]> {
    const controller = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    return raceWithDeadline(() => read(signal), {
      timer: this.timer,
      timeoutMs,
      signal: callerSignal,
      label: `Android ${label} process table`,
      timeoutError: () => {
        const error = Object.assign(new Error(`timed out after ${timeoutMs}ms`), {
          killed: true,
          signal: "SIGTERM",
          code: null,
        });
        return label === "ps"
          ? wrapCommandError(error, { command: "ps", args: PS_SNAPSHOT_ARGS })
          : error;
      },
      onTimeout: () => controller.abort(),
    });
  }

  private resetExitLatch(): void {
    this.consecutiveExitSamples = 0;
    this.exitLatched = false;
    this.warnedReasons.delete("exit");
  }

  private recordPsFailure(failure: ProcessTableFailure): void {
    if (failure.reason !== "exit") {
      this.consecutiveExitSamples = 0;
      return;
    }
    if (this.exitLatched) {
      return;
    }
    this.consecutiveExitSamples += 1;
    if (this.consecutiveExitSamples < this.exitDeterministicAfterSamples) {
      return;
    }
    this.exitLatched = true;
    this.warnedReasons.add("exit");
    logger.warn(
      `[BootAdmission] ps exit repeated for ${this.consecutiveExitSamples} exhausted samples; retries stop until ps succeeds: ${failure.detail}`,
    );
  }

  private finishPsFailure(
    failure: ProcessTableFailure,
    error: unknown,
    options: { signal?: AbortSignal },
    endMs: number,
  ): Promise<ProcessTableResult> | ProcessTableResult {
    this.recordPsFailure(failure);
    if (!failure.transient && this.procFs) {
      return this.readProc(options, endMs, failure);
    }
    return this.failed(failure, errorMessage(error));
  }

  private async readProc(
    options: { signal?: AbortSignal },
    endMs: number,
    psFailure?: ProcessTableFailure,
  ): Promise<ProcessTableResult> {
    const timeoutMs = Math.max(0, Math.min(this.attemptTimeoutMs, endMs - this.timer.now()));
    try {
      const value = await this.attempt(
        (signal) => readProcProcessTable(this.procFs!, { signal }),
        timeoutMs,
        options.signal,
        "/proc",
      );
      if (!this.procLatched) {
        logger.info(
          `[BootAdmission] ps unavailable (${psFailure?.reason}: ${psFailure?.detail}); using /proc process table instead`,
        );
        this.procLatched = true;
      }
      return { value };
    } catch (error) {
      options.signal?.throwIfAborted();
      const classified = classifyFailure(error, timeoutMs);
      const suffix = psFailure ? `; ps ${psFailure.reason}` : "";
      const detail = `/proc: ${classified.detail.slice(0, 193 - suffix.length)}${suffix}`;
      const failure = {
        ...classified,
        detail,
        transient: TRANSIENT_REASONS.has(classified.reason),
        attempts: psFailure?.attempts ?? 0,
      };
      // A failed procfs read leaves adb's count available and is warned once per reason.
      const result = this.failed(failure, detail, this.warnedProcReasons);
      this.warnedProcReasons.add(failure.reason);
      return result;
    }
  }

  private retryDelay(failure: ProcessTableFailure, endMs: number): number | undefined {
    if (!failure.transient || failure.attempts >= this.maxAttempts) {
      return undefined;
    }
    const delay = this.backoff.delayForAttempt(failure.attempts);
    return this.timer.now() + delay + MIN_RETRY_TIMEOUT_MS <= endMs ? delay : undefined;
  }

  private failed(
    failure: ProcessTableFailure,
    message = failure.detail,
    warnedReasons = this.warnedReasons,
  ): ProcessTableResult {
    const log = `[BootAdmission] emulator process snapshot unavailable: ${failure.reason}, attempts=${failure.attempts}: ${failure.detail}`;
    if (failure.reason === "unsupported-platform" || warnedReasons.has(failure.reason)) {
      // No ps is expected on Windows; repeated deterministic failures already have a WARN trace.
      logger.debug(log);
    } else {
      logger.warn(log);
    }
    if (!failure.transient) {
      warnedReasons.add(failure.reason);
    }
    return { failure, error: `ps: ${message}` };
  }
}
