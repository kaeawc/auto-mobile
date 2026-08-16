export type ShutdownSignal = "SIGINT" | "SIGTERM" | "stdin";

export interface StdinShutdownSource {
  on(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
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

export type FatalProcessEvent =
  | { type: "uncaughtException"; error: Error }
  | { type: "unhandledRejection"; reason: unknown; promise: Promise<unknown> };

export type FatalProcessHandler = (event: FatalProcessEvent) => Promise<void> | void;

export class ProcessLifecycleHandlers {
  private installed = false;
  private stdinShutdownHandlersInstalled = false;
  private shutdownInProgress = false;
  private shutdownHandler: ProcessShutdownHandler | undefined;
  private fatalProcessHandler: FatalProcessHandler | undefined;

  constructor(private readonly lifecycleProcess: ProcessLifecycleProcess) {}

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

  setShutdownHandler(handler: ProcessShutdownHandler): void {
    this.shutdownHandler = handler;
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
      await this.shutdownHandler?.(signal);
      this.lifecycleProcess.exit(0);
    } catch (error) {
      console.error(`Error during ${signal} shutdown:`, error);
      this.lifecycleProcess.exit(1);
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

export function setProcessShutdownHandler(handler: ProcessShutdownHandler): void {
  processLifecycleHandlers.setShutdownHandler(handler);
}

export function setFatalProcessHandler(handler: FatalProcessHandler): void {
  processLifecycleHandlers.setFatalProcessHandler(handler);
}
