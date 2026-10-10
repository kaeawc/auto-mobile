import type { HostChildProcess, HostSpawnOptions } from "../HostCommandExecutor";
import type { Timer } from "../SystemTimer";
import { appendBounded } from "./appendBounded";

export interface AndroidCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

interface AndroidCommandDependencies {
  spawn: (command: string, args: string[], options: HostSpawnOptions) => HostChildProcess;
  timer: Timer;
}

interface AndroidCommandRequest {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxStdoutChars: number;
  maxStderrChars: number;
  name: "avdmanager" | "sdkmanager";
  spawnErrorPrefix: string;
  terminationGraceMs: number;
  /** avdmanager waits again after SIGKILL and also settles on a terminating exit. */
  forcedSettlementDelayMs?: number;
  onStart: () => void;
  onOutput?: (stream: "stdout" | "stderr", output: string) => void;
}

/**
 * The command was stopped by its timeout or caller cancellation rather than
 * exiting on its own, so whatever it was doing may be half done.
 */
export class AndroidCommandTerminatedError extends Error {
  constructor(
    message: string,
    public readonly reason: "timeout" | "cancelled",
  ) {
    super(message);
    this.name = "AndroidCommandTerminatedError";
  }
}

/** Orchestration over the existing injectable host spawn seam, not a new process seam. */
class AndroidCommandRun {
  private settled = false;
  private terminationError?: Error;
  private timeout?: NodeJS.Timeout;
  private escalationTimeout?: NodeJS.Timeout;
  private forcedSettlementTimeout?: NodeJS.Timeout;
  private readonly result: AndroidCommandResult = {
    stdout: "",
    stderr: "",
    exitCode: null,
    stdoutTruncated: false,
    stderrTruncated: false,
  };

  constructor(
    private readonly dependencies: AndroidCommandDependencies,
    private readonly request: AndroidCommandRequest,
    private readonly child: HostChildProcess,
    private readonly resolve: (result: AndroidCommandResult) => void,
    private readonly reject: (error: Error) => void,
  ) {}

  start(): void {
    const { request, child } = this;
    request.signal?.addEventListener("abort", this.onAbort, { once: true });
    this.timeout = this.dependencies.timer.setTimeout(
      () =>
        this.terminate(
          new AndroidCommandTerminatedError(
            `${request.name} command timed out after ${request.timeoutMs}ms`,
            "timeout",
          ),
        ),
      request.timeoutMs,
    );
    request.onStart();
    child.stdout?.on("data", (data) => this.capture("stdout", data.toString()));
    child.stderr?.on("data", (data) => this.capture("stderr", data.toString()));
    child.on("close", (code) => {
      this.settle(() => {
        if (this.terminationError) {
          this.reject(this.terminationError);
          return;
        }
        this.resolve({ ...this.result, exitCode: code });
      });
    });
    if (request.forcedSettlementDelayMs !== undefined) {
      child.on("exit", () => {
        if (this.terminationError) {
          this.rejectTermination();
        }
      });
    }
    child.on("error", (error) =>
      this.settle(() => this.reject(new Error(`${request.spawnErrorPrefix}${error.message}`))),
    );
    if (request.input) {
      child.stdin?.write(request.input);
      child.stdin?.end();
    }
  }

  private capture(stream: "stdout" | "stderr", output: string): void {
    const limit = stream === "stdout" ? this.request.maxStdoutChars : this.request.maxStderrChars;
    const appended = appendBounded(this.result[stream], output, limit);
    this.result[stream] = appended.value;
    const flag = stream === "stdout" ? "stdoutTruncated" : "stderrTruncated";
    this.result[flag] ||= appended.truncated;
    this.request.onOutput?.(stream, output);
  }

  private readonly onAbort = () =>
    this.terminate(
      new AndroidCommandTerminatedError(`${this.request.name} command cancelled`, "cancelled"),
    );

  private readonly rejectTermination = () => {
    this.settle(() => this.reject(this.terminationError!));
  };

  private terminate(error: Error): void {
    const delayed = this.request.forcedSettlementDelayMs !== undefined;
    if (this.terminationError || (delayed && this.settled)) {
      return;
    }
    this.terminationError = error;
    if (delayed) {
      this.clearTimeout(this.timeout);
      this.request.signal?.removeEventListener("abort", this.onAbort);
    }
    this.child.kill("SIGTERM");
    if (delayed && this.settled) {
      return;
    }
    this.escalationTimeout = this.dependencies.timer.setTimeout(
      () => this.escalate(),
      this.request.terminationGraceMs,
    );
  }

  private escalate(): void {
    const delay = this.request.forcedSettlementDelayMs;
    if (delay === undefined) {
      this.settle(() => {
        this.child.kill("SIGKILL");
        this.reject(this.terminationError!);
      });
      return;
    }
    this.child.kill("SIGKILL");
    if (!this.settled) {
      this.forcedSettlementTimeout = this.dependencies.timer.setTimeout(
        this.rejectTermination,
        delay,
      );
    }
  }

  private clearTimeout(timeout?: NodeJS.Timeout): void {
    if (timeout) {
      this.dependencies.timer.clearTimeout(timeout);
    }
  }

  private settle(callback: () => void): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.clearTimeout(this.timeout);
    this.clearTimeout(this.escalationTimeout);
    this.clearTimeout(this.forcedSettlementTimeout);
    this.request.signal?.removeEventListener("abort", this.onAbort);
    callback();
  }
}

export function runAndroidCommand(
  dependencies: AndroidCommandDependencies,
  request: AndroidCommandRequest,
): Promise<AndroidCommandResult> {
  return new Promise((resolve, reject) => {
    if (request.signal?.aborted) {
      reject(new Error(`${request.name} command cancelled`));
      return;
    }
    const child = dependencies.spawn(request.command, request.args, {
      env: request.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    new AndroidCommandRun(dependencies, request, child, resolve, reject).start();
  });
}
