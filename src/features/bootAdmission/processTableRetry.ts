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
import { readHostProcessTable } from "../iosSimFleet/FleetHostSource";
import type { HostProcessRow } from "../iosSimFleet/types";

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
}

interface ProcessTableResult {
  value?: HostProcessRow[];
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

function exitReason(code: number, stderr: unknown): ProcessTableFailureReason {
  if (code === 0) {
    return "unknown";
  }
  const text = Buffer.isBuffer(stderr)
    ? stderr.toString()
    : typeof stderr === "string"
      ? stderr
      : "";
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
  return errorMessage(error).startsWith("ps returned no parseable processes")
    ? "unparseable"
    : "unknown";
}

/** ExecSeam preserves the raw exec error in cause, rather than copying its status fields. */
function classifyFailure(error: unknown): ProcessTableFailureReason {
  const seen = new Set<unknown>();
  let reason: ProcessTableFailureReason = "unknown";
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
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return reason;
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
  }

  async read(options: { signal?: AbortSignal; deadlineMs?: number }): Promise<ProcessTableResult> {
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
    let retriedReason: ProcessTableFailureReason | undefined;
    for (let attempts = 1; ; attempts++) {
      options.signal?.throwIfAborted();
      const timeoutMs = Math.min(this.attemptTimeoutMs, Math.max(endMs - this.timer.now(), 250));
      try {
        const value = await readHostProcessTable(this.executor, {
          signal: options.signal,
          timeoutMs,
        });
        if (retriedReason) {
          logger.info(
            `[BootAdmission] emulator process snapshot succeeded on attempt ${attempts} after ${retriedReason}`,
          );
        }
        return { value };
      } catch (error) {
        options.signal?.throwIfAborted();
        const reason = classifyFailure(error);
        const transient = TRANSIENT_REASONS.has(reason);
        const failure = {
          reason,
          transient,
          attempts,
          detail: errorMessage(error).split(/\r?\n/, 1)[0].slice(0, 200),
        };
        const delay = this.retryDelay(failure, endMs);
        if (delay === undefined) {
          return this.failed(failure, errorMessage(error));
        }
        retriedReason = reason;
        // Only sleep is raced, so an aborted waiter never starts another ps in the background.
        await raceWithDeadline(() => this.timer.sleep(delay), {
          timer: this.timer,
          signal: options.signal,
          label: "Android process table retry backoff",
        });
      }
    }
  }

  private retryDelay(failure: ProcessTableFailure, endMs: number): number | undefined {
    if (!failure.transient || failure.attempts >= this.maxAttempts) {
      return undefined;
    }
    const delay = this.backoff.delayForAttempt(failure.attempts);
    return this.timer.now() + delay + 250 <= endMs ? delay : undefined;
  }

  private failed(failure: ProcessTableFailure, message = failure.detail): ProcessTableResult {
    const log = `[BootAdmission] emulator process snapshot unavailable: ${failure.reason}, attempts=${failure.attempts}: ${failure.detail}`;
    if (failure.reason === "unsupported-platform" || this.warnedReasons.has(failure.reason)) {
      // No ps is expected on Windows; repeated deterministic failures already have a WARN trace.
      logger.debug(log);
    } else {
      logger.warn(log);
    }
    if (!failure.transient) {
      this.warnedReasons.add(failure.reason);
    }
    return { failure, error: `ps: ${message}` };
  }
}
