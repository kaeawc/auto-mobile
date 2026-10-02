import type { ScreenshotPathProtection } from "../../src/features/observe/ScreenshotPathProtection";
import { SCREENSHOT_MIN_LIFETIME_MS } from "../../src/features/observe/screenshotCacheEviction";
import type { Timer } from "../../src/utils/SystemTimer";

export class FakeScreenshotPathProtection implements ScreenshotPathProtection {
  readonly calls: string[] = [];
  private readonly deadlines = new Map<string, number>();
  constructor(private readonly timer: Timer) {}
  async protect(path: string): Promise<void> {
    this.calls.push(path);
    this.deadlines.set(path, this.timer.now() + SCREENSHOT_MIN_LIFETIME_MS);
  }
  async removeIfUnprotected(path: string, remove: () => Promise<boolean>): Promise<boolean> {
    return this.isProtected(path) ? false : remove();
  }
  isProtected(path: string): boolean {
    return (this.deadlines.get(path) ?? 0) > this.timer.now();
  }
}
