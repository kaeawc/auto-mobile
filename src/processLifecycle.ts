import { defaultTimer, type Timer } from "./utils/SystemTimer";
import { writeEmergencyLog } from "./utils/loggingConfig";
import { raceWithDeadline } from "./utils/raceWithDeadline";

/**
 * What started a shutdown. `execution-owner-lost` is a managed slot proxy whose execution owner
 * exited or which was re-parented (#11176).
 */
export type ShutdownSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "stdin" | "execution-owner-lost";

// A clean recording finalization alone requires one second. Leave enough time
// for every child owner to receive a bounded stop or force-stop attempt, while
// leaving the finalization tail below the daemon supervisor's 10-second kill.
export const PROCESS_SHUTDOWN_TIMEOUT_MS = 9_000;
const PROCESS_SHUTDOWN_FINALIZATION_TIMEOUT_MS = 100;

export interface StdinShutdownSource {
  on(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type ShutdownCleanupOperation = () => void | Promise<void>;

export async function runAllCleanupOperations(
  cleanupOperations: readonly ShutdownCleanupOperation[],
  onCleanupFailure?: (error: unknown) => void,
): Promise<void> {
  const cleanupResults = await Promise.allSettled(
    cleanupOperations.map((operation) =>
      Promise.resolve()
        .then(operation)
        .catch((error) => {
          onCleanupFailure?.(error);
          throw error;
        }),
    ),
  );
  const cleanupFailures = cleanupResults.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures.map((result) => result.reason),
      "One or more shutdown cleanup operations failed",
    );
  }
}

export type ProcessLifecycleEventMap = {
  SIGINT: [];
  SIGTERM: [];
  SIGHUP: [];
  uncaughtException: [Error];
  unhandledRejection: [unknown, Promise<unknown>];
};

export interface ProcessLifecycleProcess {
  on<K extends keyof ProcessLifecycleEventMap>(
    event: K,
    listener: (...args: ProcessLifecycleEventMap[K]) => void,
  ): unknown;
  exit(code?: number): never;
}

export type ProcessShutdownHandler = (signal: ShutdownSignal) => Promise<void> | void;
type ProcessShutdownTimeoutResult = { exitCode?: number };
type ProcessShutdownTimeoutHandler = () =>
  | Promise<ProcessShutdownTimeoutResult | undefined>
  | ProcessShutdownTimeoutResult
  | undefined;

export type FatalProcessEvent =
  | { type: "uncaughtException"; error: Error }
  | { type: "unhandledRejection"; reason: unknown; promise: Promise<unknown> };

export type FatalProcessHandler = (event: FatalProcessEvent) => Promise<void> | void;

export class ProcessLifecycleHandlers {
  private installed = false;
  private stdinShutdownHandlersInstalled = false;
  private hangupShutdownHandlerInstalled = false;
  private shutdownInProgress = false;
  private shutdownHandler: ProcessShutdownHandler | undefined;
  private shutdownTimeoutHandler: ProcessShutdownTimeoutHandler | undefined;
  private fatalProcessHandler: FatalProcessHandler | undefined;

  constructor(
    private readonly lifecycleProcess: ProcessLifecycleProcess,
    private readonly timer: Timer = defaultTimer,
    private readonly shutdownTimeoutMs: number = PROCESS_SHUTDOWN_TIMEOUT_MS,
  ) {}

  install(): void {
    if (this.installed) {
      return;
    }
    this.installed = true;

    this.lifecycleProcess.on("SIGINT", () => {
      void this.shutdown("SIGINT");
    });
    this.lifecycleProcess.on("SIGTERM", () => {
      void this.shutdown("SIGTERM");
    });
    this.lifecycleProcess.on("uncaughtException", (error) => {
      void this.handleFatalProcessEvent({ type: "uncaughtException", error });
    });
    this.lifecycleProcess.on("unhandledRejection", (reason, promise) => {
      void this.handleFatalProcessEvent({ type: "unhandledRejection", reason, promise });
    });
  }

  setShutdownHandler(
    handler: ProcessShutdownHandler,
    timeoutHandler?: ProcessShutdownTimeoutHandler,
  ): void {
    this.shutdownHandler = handler;
    this.shutdownTimeoutHandler = timeoutHandler;
  }

  setFatalProcessHandler(handler: FatalProcessHandler): void {
    this.fatalProcessHandler = handler;
  }

  /**
   * Treat SIGHUP like SIGTERM. Only the daemon opts in (#11156): a daemon left
   * attached to a terminal otherwise dies on hangup without any cleanup.
   */
  installHangupShutdownHandler(): void {
    if (this.hangupShutdownHandlerInstalled) {
      return;
    }
    this.hangupShutdownHandlerInstalled = true;
    this.lifecycleProcess.on("SIGHUP", () => {
      void this.shutdown("SIGHUP");
    });
  }

  installStdinShutdownHandlers(stdin: StdinShutdownSource): void {
    if (this.stdinShutdownHandlersInstalled) {
      return;
    }
    this.stdinShutdownHandlersInstalled = true;

    const shutdownOnStdinClose = () => {
      void this.shutdown("stdin");
    };
    stdin.on("end", shutdownOnStdinClose);
    stdin.on("error", shutdownOnStdinClose);
    stdin.on("close", shutdownOnStdinClose);
  }

  /** Start the same shutdown a signal would, for an in-process reason (#11176). */
  requestShutdown(signal: ShutdownSignal): Promise<void> {
    return this.shutdown(signal);
  }

  private async shutdown(signal: ShutdownSignal): Promise<void> {
    if (this.shutdownInProgress) {
      return;
    }
    this.shutdownInProgress = true;

    try {
      const shutdownCompleted = await this.runShutdownHandler(signal);
      let exitCode = 0;
      if (!shutdownCompleted) {
        writeEmergencyLog(`Shutdown timed out after ${this.shutdownTimeoutMs}ms; forcing exit`);
        exitCode = (await this.runShutdownTimeoutHandler())?.exitCode ?? 1;
      }
      this.lifecycleProcess.exit(exitCode);
    } catch (error) {
      writeEmergencyLog(`Error during ${signal} shutdown`, error);
      this.lifecycleProcess.exit(1);
    }
  }

  private async runShutdownHandler(signal: ShutdownSignal): Promise<boolean> {
    const handler = this.shutdownHandler;
    if (!handler) {
      return true;
    }

    const timedOut = Symbol("shutdown timeout");
    try {
      await raceWithDeadline(() => Promise.resolve(handler(signal)), {
        timer: this.timer,
        timeoutMs: this.shutdownTimeoutMs,
        label: "Process shutdown",
        timeoutError: () => timedOut,
      });
      return true;
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
      return false;
    }
  }

  private async runShutdownTimeoutHandler(): Promise<ProcessShutdownTimeoutResult | undefined> {
    const handler = this.shutdownTimeoutHandler;
    if (!handler) {
      return undefined;
    }

    const finalizationTimeoutMs = Math.min(
      this.shutdownTimeoutMs,
      PROCESS_SHUTDOWN_FINALIZATION_TIMEOUT_MS,
    );
    const timedOut = Symbol("shutdown finalization timeout");
    try {
      return await raceWithDeadline(Promise.resolve(handler()), {
        timer: this.timer,
        timeoutMs: finalizationTimeoutMs,
        label: "Shutdown finalization",
        timeoutError: () => timedOut,
      });
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
      writeEmergencyLog(
        `Shutdown finalization timed out after ${finalizationTimeoutMs}ms; forcing exit`,
      );
      return undefined;
    }
  }

  private async handleFatalProcessEvent(event: FatalProcessEvent): Promise<void> {
    const handler = this.fatalProcessHandler;
    if (!handler) {
      if (event.type === "uncaughtException") {
        writeEmergencyLog("Uncaught exception", event.error);
      } else {
        writeEmergencyLog("Unhandled rejection", event.reason);
      }
      this.lifecycleProcess.exit(1);
      return;
    }

    try {
      await handler(event);
    } catch (error) {
      writeEmergencyLog("Error in fatal process handler", error);
      this.lifecycleProcess.exit(1);
    }
  }
}

const processLifecycleHandlers = new ProcessLifecycleHandlers(process);

export function installProcessLifecycleHandlers(): void {
  processLifecycleHandlers.install();
}

export function installHangupShutdownHandler(): void {
  processLifecycleHandlers.installHangupShutdownHandler();
}

export function installStdinShutdownHandlers(stdin: StdinShutdownSource = process.stdin): void {
  processLifecycleHandlers.installStdinShutdownHandlers(stdin);
}

/** Shut the process down through the registered handler, as a signal would (#11176). */
export function requestProcessShutdown(signal: ShutdownSignal): Promise<void> {
  return processLifecycleHandlers.requestShutdown(signal);
}

export function setProcessShutdownHandler(
  handler: ProcessShutdownHandler,
  timeoutHandler?: ProcessShutdownTimeoutHandler,
): void {
  processLifecycleHandlers.setShutdownHandler(handler, timeoutHandler);
}

export function setFatalProcessHandler(handler: FatalProcessHandler): void {
  processLifecycleHandlers.setFatalProcessHandler(handler);
}
