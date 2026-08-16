import { defaultTimer, type Timer } from "./utils/SystemTimer";

export type ShutdownSignal = "SIGINT" | "SIGTERM" | "stdin";

const PROCESS_SHUTDOWN_TIMEOUT_MS = 5_000;

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
    cleanupOperations.map(operation => Promise.resolve().then(operation).catch(error => {
      onCleanupFailure?.(error);
      throw error;
    })),
  );
  const cleanupFailures = cleanupResults.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures.map(result => result.reason),
      "One or more shutdown cleanup operations failed",
    );
  }
}

export type ProcessLifecycleEventMap = {
  SIGINT: [];
  SIGTERM: [];
  uncaughtException: [Error];
  unhandledRejection: [unknown, Promise<unknown>];
};

export interface ProcessLifecycleProcess {
  on<K extends keyof ProcessLifecycleEventMap>(
    event: K,
    listener: (...args: ProcessLifecycleEventMap[K]) => void
  ): unknown;
  exit(code?: number): never;
}

export type ProcessShutdownHandler = (signal: ShutdownSignal) => Promise<void> | void;
type ProcessShutdownTimeoutHandler = () =>
  | Promise<{ exitCode?: number } | undefined>
  | { exitCode?: number }
  | undefined;

export type FatalProcessEvent =
  | { type: "uncaughtException"; error: Error }
  | { type: "unhandledRejection"; reason: unknown; promise: Promise<unknown> };

export type FatalProcessHandler = (event: FatalProcessEvent) => Promise<void> | void;

export class ProcessLifecycleHandlers {
  private installed = false;
  private stdinShutdownHandlersInstalled = false;
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
    this.lifecycleProcess.on("uncaughtException", error => {
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

  private async shutdown(signal: ShutdownSignal): Promise<void> {
    if (this.shutdownInProgress) {
      return;
    }
    this.shutdownInProgress = true;

    try {
      const shutdownCompleted = await this.runShutdownHandler(signal);
      let exitCode = 0;
      if (!shutdownCompleted) {
        console.error(`Shutdown timed out after ${this.shutdownTimeoutMs}ms; forcing exit`);
        exitCode = (await this.shutdownTimeoutHandler?.())?.exitCode ?? 0;
      }
      this.lifecycleProcess.exit(exitCode);
    } catch (error) {
      console.error(`Error during ${signal} shutdown:`, error);
      this.lifecycleProcess.exit(1);
    }
  }

  private async runShutdownHandler(signal: ShutdownSignal): Promise<boolean> {
    const handler = this.shutdownHandler;
    if (!handler) {
      return true;
    }

    if (signal !== "stdin") {
      await handler(signal);
      return true;
    }

    let timeoutHandle: NodeJS.Timeout | undefined;
    const completed = handler(signal);
    const timedOut = new Promise<false>(resolve => {
      timeoutHandle = this.timer.setTimeout(() => resolve(false), this.shutdownTimeoutMs);
    });

    try {
      return (await Promise.race([completed, timedOut])) !== false;
    } finally {
      if (timeoutHandle !== undefined) {
        this.timer.clearTimeout(timeoutHandle);
      }
    }
  }

  private async handleFatalProcessEvent(event: FatalProcessEvent): Promise<void> {
    const handler = this.fatalProcessHandler;
    if (!handler) {
      if (event.type === "uncaughtException") {
        console.error("Uncaught exception:", event.error);
      } else {
        console.error("Unhandled rejection at:", event.promise, "reason:", event.reason);
      }
      this.lifecycleProcess.exit(1);
      return;
    }

    try {
      await handler(event);
    } catch (error) {
      console.error("Error in fatal process handler:", error);
      this.lifecycleProcess.exit(1);
    }
  }
}

const processLifecycleHandlers = new ProcessLifecycleHandlers(process);

export function installProcessLifecycleHandlers(): void {
  processLifecycleHandlers.install();
}

export function installStdinShutdownHandlers(stdin: StdinShutdownSource = process.stdin): void {
  processLifecycleHandlers.installStdinShutdownHandlers(stdin);
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
