import { ForcedRestartBudget } from "../../../ctrlProxy/ForcedRestartBudget";
import type { CtrlProxyIosManager } from "../../../ctrlProxy/IOSCtrlProxyManager";

/**
 * No-op factory used by createForTesting so that tests which don't supply
 * a factory never trigger real CtrlProxy setup on connection failure.
 */
export class NoOpIOSCtrlProxyManager implements CtrlProxyIosManager {
  private readonly forcedRestartBudget = new ForcedRestartBudget();
  getForcedRestartBudget(): ForcedRestartBudget {
    return this.forcedRestartBudget;
  }
  async setup(): Promise<{ success: false; message: string }> {
    return { success: false, message: "no-op test stub" };
  }
  async isInstalled(): Promise<boolean> {
    return false;
  }
  async isRunning(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return false;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getServicePort(): number {
    return 0;
  }
  async getReportedRunnerPort(): Promise<number | null> {
    return null;
  }
  setAutoRestart(): void {}
  isAutoRestartEnabled(): boolean {
    return false;
  }
  async forceRestart(): Promise<void> {}
  resetSetupState(): void {}
}
