import type { ScreenshotBackoffScheduler } from "../../src/features/observe/ScreenshotBackoffScheduler";

export class FakeScreenshotBackoffScheduler implements ScreenshotBackoffScheduler {
  public startBackoffSequenceCalls: number = 0;
  public cancelPendingCapturesCalls: number = 0;
  public stopCalls: number = 0;
  public rescheduleKeepAliveCalls: number = 0;
  public noteCaptureStartedCalls: number = 0;
  private _isActive: boolean = false;
  private _pendingCount: number = 0;

  startBackoffSequence(): void {
    this.startBackoffSequenceCalls++;
    this._isActive = true;
    this._pendingCount = 6; // Default intervals count
  }

  cancelPendingCaptures(): void {
    this.cancelPendingCapturesCalls++;
    this._isActive = false;
    this._pendingCount = 0;
  }

  stop(): void {
    this.stopCalls++;
    this.cancelPendingCaptures();
  }

  isActive(): boolean {
    return this._isActive;
  }

  getPendingCount(): number {
    return this._pendingCount;
  }

  rescheduleKeepAlive(): void {
    this.rescheduleKeepAliveCalls++;
  }

  noteCaptureStarted(): void {
    this.noteCaptureStartedCalls++;
  }

  // Test helpers
  setActive(active: boolean): void {
    this._isActive = active;
  }

  setPendingCount(count: number): void {
    this._pendingCount = count;
  }

  reset(): void {
    this.startBackoffSequenceCalls = 0;
    this.cancelPendingCapturesCalls = 0;
    this.stopCalls = 0;
    this.rescheduleKeepAliveCalls = 0;
    this.noteCaptureStartedCalls = 0;
    this._isActive = false;
    this._pendingCount = 0;
  }
}
