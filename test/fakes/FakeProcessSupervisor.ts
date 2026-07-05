import { type ProcessSupervisor } from "../../src/utils/ProcessSupervisor";

export class FakeProcessSupervisor implements ProcessSupervisor {
  public startCalls = 0;
  public stopCalls = 0;
  public processExitedCalls = 0;
  public setAutoRestartCalls: boolean[] = [];
  public alive = true;
  private autoRestartEnabled = true;

  public async start(): Promise<void> {
    this.startCalls++;
  }

  public stop(): void {
    this.stopCalls++;
  }

  public processExited(): void {
    this.processExitedCalls++;
  }

  public async isAlive(): Promise<boolean> {
    return this.alive;
  }

  public setAutoRestart(enabled: boolean): void {
    this.setAutoRestartCalls.push(enabled);
    this.autoRestartEnabled = enabled;
  }

  public isAutoRestartEnabled(): boolean {
    return this.autoRestartEnabled;
  }
}
