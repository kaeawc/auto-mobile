import { createHash } from "node:crypto";
import path from "node:path";
import { errorMessage } from "../../utils/describeUnknownError";
import type { FileSystem } from "../../utils/filesystem/DefaultFileSystem";
import type { IdGenerator } from "../../utils/IdGenerator";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import type { DesktopHeadUnitConsole } from "./DesktopHeadUnit";

/**
 * A hash of what the head unit shows, for projected apps without the template route (#17842). It
 * tells changed from unchanged pixels, nothing about which screen is shown.
 */
export interface HeadUnitScreenshotSource {
  /** Undefined when no capture arrived (for example a headless DHU without video focus). */
  hash(signal?: AbortSignal): Promise<string | undefined>;
}

export interface HeadUnitScreenshotTiming {
  pollMs: number;
  /** How long to wait for the DHU to finish writing the PNG. */
  timeoutMs: number;
}

export const DEFAULT_HEAD_UNIT_SCREENSHOT_TIMING: HeadUnitScreenshotTiming = {
  pollMs: 50,
  timeoutMs: 2_000,
};

type ScreenshotFiles = Pick<FileSystem, "pathExists" | "stat" | "readFileBuffer" | "remove">;

export interface DhuScreenshotHashDependencies {
  files: ScreenshotFiles;
  timer: Timer;
  ids: IdGenerator;
  /** Host directory the DHU writes captures to; the DHU runs on this host. */
  directory: string;
  timing?: HeadUnitScreenshotTiming;
}

/** Sends `screenshot <file>` to the DHU console and hashes the PNG once its size stops growing. */
export class DhuScreenshotHashSource implements HeadUnitScreenshotSource {
  constructor(
    private readonly dhuConsole: DesktopHeadUnitConsole,
    private readonly deps: DhuScreenshotHashDependencies,
  ) {}

  async hash(signal?: AbortSignal): Promise<string | undefined> {
    const file = path.join(this.deps.directory, `automobile-head-unit-${this.deps.ids.next()}.png`);
    this.dhuConsole.sendCommand(`screenshot ${file}`);
    try {
      return await this.waitForCapture(file, signal);
    } finally {
      await this.deps.files.remove(file).catch((error: unknown) => {
        // The capture may never have been written; a leftover temp PNG is harmless.
        logger.debug(`[AndroidAuto] could not remove ${file}: ${errorMessage(error)}`);
      });
    }
  }

  private async waitForCapture(file: string, signal?: AbortSignal): Promise<string | undefined> {
    const { pollMs, timeoutMs } = this.deps.timing ?? DEFAULT_HEAD_UNIT_SCREENSHOT_TIMING;
    const { files, timer } = this.deps;
    const start = timer.now();
    let lastSize = -1;
    while (timer.now() - start < timeoutMs) {
      await timer.sleep(pollMs);
      signal?.throwIfAborted();
      const size = (await files.pathExists(file)) ? (await files.stat(file)).size : 0;
      if (size > 0 && size === lastSize) {
        return createHash("sha256")
          .update(await files.readFileBuffer(file))
          .digest("hex");
      }
      lastSize = size;
    }
    logger.warn(`[AndroidAuto] no head unit screenshot at ${file} after ${timeoutMs} ms`);
    return undefined;
  }
}
