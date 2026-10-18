import nodePath from "node:path";
import type {
  ScreenshotPathProtection,
  ScreenshotRetentionWrite,
} from "../../src/features/observe/ScreenshotRetention";
import { SCREENSHOT_PATH_MIN_LIFETIME_MS } from "../../src/features/observe/ScreenshotRetention";
import { toActionableError } from "../../src/models/ActionableError";
import type { Timer } from "../../src/utils/SystemTimer";

/**
 * Mirrors BoundedScreenshotPathProtection's lease, removal-fencing and write-ordering
 * behaviour (contract: test/contracts/ScreenshotPathProtectionContract.ts, #11868).
 * Capacity eviction and the inventory sweep are deliberately not modelled.
 */
export class FakeScreenshotPathProtection implements ScreenshotPathProtection {
  readonly calls: string[] = [];
  readonly sweepCalls: string[] = [];
  private readonly sweptDirectories = new Set<string>();
  private readonly deadlines = new Map<string, number>();
  private readonly removals = new Map<string, Promise<boolean>>();
  private readonly directoryTails = new Map<string, Promise<void>>();
  constructor(private readonly timer: Timer) {}
  async protect(path: string): Promise<number> {
    this.calls.push(path);
    const removal = this.removals.get(path);
    if (removal) {
      await removal;
    }
    const deadline = Math.max(
      this.deadlines.get(path) ?? 0,
      this.timer.now() + SCREENSHOT_PATH_MIN_LIFETIME_MS,
    );
    this.deadlines.set(path, deadline);
    return deadline;
  }
  start(): void {}
  async sweep(): Promise<void> {}
  async sweepOnce(directory: string): Promise<void> {
    if (!this.sweptDirectories.has(directory)) {
      this.sweptDirectories.add(directory);
      this.sweepCalls.push(directory);
      await this.sweep();
    }
  }
  async write(path: string, operation: ScreenshotRetentionWrite): Promise<void> {
    const directory = nodePath.dirname(path);
    const run = async (): Promise<boolean> => {
      try {
        await operation.write();
      } catch (error) {
        throw toActionableError(error, "Failed to write retained screenshot");
      }
      return false;
    };
    // Only queue behind an unsettled write: an idle directory starts synchronously, like the
    // real store, so cancellation races in callers see the same microtask depth.
    const previous = this.directoryTails.get(directory);
    const transition = previous ? previous.then(run) : run();
    const tail = transition.then(
      () => undefined,
      () => undefined,
    );
    this.directoryTails.set(directory, tail);
    // Readers cannot remove or lease the path until the write settles.
    this.removals.set(path, transition);
    try {
      await transition;
    } finally {
      this.removals.delete(path);
      void tail.then(() => {
        if (this.directoryTails.get(directory) === tail) {
          this.directoryTails.delete(directory);
        }
      });
    }
  }
  async removeIfUnprotected(path: string, remove: () => Promise<boolean>): Promise<boolean> {
    if (this.isProtected(path) || this.removals.has(path)) {
      return false;
    }
    const removal = Promise.resolve().then(remove);
    this.removals.set(path, removal);
    try {
      return await removal;
    } finally {
      this.removals.delete(path);
    }
  }
  isProtected(path: string): boolean {
    return (this.deadlines.get(path) ?? 0) > this.timer.now();
  }
}
