import nodePath from "node:path";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import {
  SCREENSHOT_CACHE_MAX_SIZE_BYTES,
  SCREENSHOT_MIN_LIFETIME_MS,
  screenshotPathKey,
  type ScreenshotPathModule,
} from "./screenshotCacheEviction";

/**
 * 4096 slots = the existing 128 MiB disk budget / a conservative 32 KiB
 * accounting allowance per path. This bounds bookkeeping independently of
 * devices, sessions and capture rate (which has no enforced maximum). This is
 * a count bound, not a claim that screenshot bytes or JS entries are 32 KiB.
 * Overload drops the oldest protection and explicitly weakens its guarantee.
 */
export const MAX_SCREENSHOT_PATH_PROTECTIONS = SCREENSHOT_CACHE_MAX_SIZE_BYTES / (32 * 1024);

export interface ScreenshotPathProtection {
  protect(path: string): Promise<void>;
  /** Serialize publication with a local deletion already in flight. */
  removeIfUnprotected(path: string, remove: () => Promise<boolean>): Promise<boolean>;
  isProtected(path: string): boolean;
}

/** Process-local return leases; repeated publication extends, never shortens. */
export class BoundedScreenshotPathProtection implements ScreenshotPathProtection {
  private readonly deadlines = new Map<string, number>();
  private readonly removals = new Map<string, Promise<boolean>>();
  private lastPrunedAt: number | undefined;

  constructor(
    private readonly timer: Timer = defaultTimer,
    private readonly pathModule: ScreenshotPathModule = nodePath,
  ) {}

  async protect(path: string): Promise<void> {
    const key = screenshotPathKey(path, this.pathModule);
    const removal = this.removals.get(key);
    if (removal) {
      await removal;
    }
    const now = this.timer.now();
    this.prune(now);
    const deadline = Math.max(this.deadlines.get(key) ?? 0, now + SCREENSHOT_MIN_LIFETIME_MS);
    this.deadlines.delete(key);
    this.deadlines.set(key, deadline);
    if (this.deadlines.size > MAX_SCREENSHOT_PATH_PROTECTIONS) {
      const oldest = this.deadlines.keys().next().value;
      if (oldest !== undefined) {
        this.deadlines.delete(oldest);
        logger.warn(
          `Screenshot protection capacity ${MAX_SCREENSHOT_PATH_PROTECTIONS} exceeded; dropped oldest protection: ${oldest}`,
        );
      }
    }
  }

  async removeIfUnprotected(path: string, remove: () => Promise<boolean>): Promise<boolean> {
    const key = screenshotPathKey(path, this.pathModule);
    if (this.isProtected(path) || this.removals.has(key)) {
      return false;
    }
    // Register before invoking asynchronous filesystem code; publication waits
    // for it to finish, then stats the path and never returns a deleted file.
    const removal = Promise.resolve().then(remove);
    this.removals.set(key, removal);
    try {
      return await removal;
    } finally {
      this.removals.delete(key);
    }
  }

  isProtected(path: string): boolean {
    this.prune(this.timer.now());
    return this.deadlines.has(screenshotPathKey(path, this.pathModule));
  }

  private prune(now: number): void {
    if (this.lastPrunedAt === now) {
      return;
    }
    this.lastPrunedAt = now;
    for (const [path, deadline] of this.deadlines) {
      if (deadline <= now) {
        this.deadlines.delete(path);
      }
    }
  }
}

export const screenshotPathProtection: ScreenshotPathProtection =
  new BoundedScreenshotPathProtection();
