import { errorMessage } from "./describeUnknownError";
import { type BackoffPolicy } from "./Backoff";
import { type Timer } from "./SystemTimer";
import { logger } from "./logger";

export interface ProcessSupervisor {
  start(): Promise<void>;
  stop(): void;
  processExited(): void;
  isAlive(): Promise<boolean>;
  setAutoRestart(enabled: boolean): void;
  isAutoRestartEnabled(): boolean;
}

export interface ProcessSupervisorOptions {
  readonly name: string;
  readonly timer: Timer;
  readonly monitorIntervalMs: number;
  readonly restartBackoff: BackoffPolicy;
  readonly restart: () => Promise<void>;
  readonly isAlive: () => Promise<boolean>;
  readonly onExit?: () => void | Promise<void>;
  readonly onRestartSuccess?: () => void | Promise<void>;
  readonly onRestartFailure?: (error: unknown) => void | Promise<void>;
  readonly maxRestartAttempts?: number;
}

export class DefaultProcessSupervisor implements ProcessSupervisor {
  private monitorInterval: ReturnType<Timer["setInterval"]> | null = null;
  private restartTimeout: ReturnType<Timer["setTimeout"]> | null = null;
  private restartAttempts = 0;
  private isStopping = false;
  private autoRestartEnabled = true;

  public constructor(private readonly options: ProcessSupervisorOptions) {}

  public async start(): Promise<void> {
    this.isStopping = false;
    this.startMonitoring();
  }

  public stop(): void {
    this.isStopping = true;
    this.stopMonitoring();
    this.clearRestartTimeout();
    this.restartAttempts = 0;
  }

  public processExited(): void {
    void this.handleProcessExit();
  }

  private async handleProcessExit(): Promise<void> {
    this.stopMonitoring();
    await this.options.onExit?.();

    if (this.autoRestartEnabled && !this.isStopping) {
      this.scheduleRestart();
    }
  }

  public isAlive(): Promise<boolean> {
    return this.options.isAlive();
  }

  public setAutoRestart(enabled: boolean): void {
    this.autoRestartEnabled = enabled;
    if (!enabled) {
      this.clearRestartTimeout();
    }
  }

  public isAutoRestartEnabled(): boolean {
    return this.autoRestartEnabled;
  }

  private startMonitoring(): void {
    this.stopMonitoring();
    this.monitorInterval = this.options.timer.setInterval(() => {
      void this.checkLiveness();
    }, this.options.monitorIntervalMs);
  }

  private stopMonitoring(): void {
    if (this.monitorInterval) {
      this.options.timer.clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  private async checkLiveness(): Promise<void> {
    try {
      if (!(await this.options.isAlive())) {
        logger.warn(`[ProcessSupervisor] ${this.options.name} is no longer alive`);
        this.processExited();
      }
    } catch (error) {
      logger.warn(
        `[ProcessSupervisor] ${this.options.name} liveness check failed: ` +
          `${errorMessage(error)}`,
      );
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimeout || this.isStopping || !this.autoRestartEnabled) {
      return;
    }

    const maxAttempts = this.options.maxRestartAttempts;
    if (maxAttempts !== undefined && this.restartAttempts >= maxAttempts) {
      logger.warn(
        `[ProcessSupervisor] ${this.options.name} max restart attempts (${maxAttempts}) reached`,
      );
      this.restartAttempts = 0;
      return;
    }

    this.restartAttempts++;
    const attempt = this.restartAttempts;
    const delay = this.options.restartBackoff.delayForAttempt(attempt);
    logger.info(
      `[ProcessSupervisor] Scheduling ${this.options.name} restart in ${delay}ms (attempt ${attempt})`,
    );

    this.restartTimeout = this.options.timer.setTimeout(() => {
      this.restartTimeout = null;
      if (this.isStopping) {
        return;
      }
      void this.restart(attempt);
    }, delay);
  }

  private async restart(attempt: number): Promise<void> {
    try {
      await this.options.restart();
      if (this.isStopping) {
        return;
      }
      this.restartAttempts = 0;
      await this.options.onRestartSuccess?.();
      this.startMonitoring();
    } catch (error) {
      await this.options.onRestartFailure?.(error);
      logger.warn(
        `[ProcessSupervisor] ${this.options.name} restart attempt ${attempt} failed: ` +
          `${errorMessage(error)}`,
      );
      this.scheduleRestart();
    }
  }

  private clearRestartTimeout(): void {
    if (this.restartTimeout) {
      this.options.timer.clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }
  }
}
