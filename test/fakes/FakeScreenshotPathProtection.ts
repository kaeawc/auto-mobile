import type { ScreenshotPathProtection } from "../../src/features/observe/ScreenshotPathProtection";
import { SCREENSHOT_PATH_MIN_LIFETIME_MS } from "../../src/features/observe/ScreenshotRetention";
import type { Timer } from "../../src/utils/SystemTimer";

export class FakeScreenshotPathProtection implements ScreenshotPathProtection {
  readonly calls: string[] = [];
  readonly sweepCalls: string[] = [];
  private readonly sweptDirectories = new Set<string>();
  private readonly deadlines = new Map<string, number>();
  constructor(private readonly timer: Timer) {}
  async protect(path: string): Promise<number> {
    this.calls.push(path);
    const deadline = this.timer.now() + SCREENSHOT_PATH_MIN_LIFETIME_MS;
    this.deadlines.set(path, deadline);
    return deadline;
  }
  start(): void {}
  async sweep(): Promise<void> {}
  async sweepOnce(directory: string): Promise<void> {
    if (!this.sweptDirectories.has(directory)) {
      this.sweptDirectories.add(directory);
      this.sweepCalls.push(directory);
      await this.sweep(directory);
    }
  }
  async write(
    _path: string,
    operation: import("../../src/features/observe/ScreenshotRetention").ScreenshotRetentionWrite,
  ): Promise<void> {
    await operation.write();
  }
  async removeIfUnprotected(path: string, remove: () => Promise<boolean>): Promise<boolean> {
    return this.isProtected(path) ? false : remove();
  }
  isProtected(path: string): boolean {
    return (this.deadlines.get(path) ?? 0) > this.timer.now();
  }
}
