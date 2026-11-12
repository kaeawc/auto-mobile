import type { CtrlProxyCaptureCooldown } from "../../src/features/observe/android/CtrlProxyCaptureCooldown";

export class FakeCtrlProxyCaptureCooldown implements CtrlProxyCaptureCooldown {
  readonly failures: string[] = [];
  readonly cleared: string[] = [];
  readonly recent = new Set<string>();

  hasRecentFailure(deviceId: string): boolean {
    return this.recent.has(deviceId);
  }
  recordFailure(deviceId: string): void {
    this.failures.push(deviceId);
    this.recent.add(deviceId);
  }
  clear(deviceId: string): void {
    this.cleared.push(deviceId);
    this.recent.delete(deviceId);
  }
}
