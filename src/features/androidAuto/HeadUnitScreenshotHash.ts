import { createHash } from "node:crypto";
import path from "node:path";
import { AMBIENT_ENV, readEnvTrimmed } from "../../config/env";
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
  /**
   * Host directories the DHU may write captures to, in order of preference; the DHU runs on this
   * host. The first whose capture path has no whitespace is used, because the DHU console may split
   * `screenshot <file>` on spaces (a Windows temp directory under `C:\Users\First Last`).
   */
  directories: readonly string[];
  timing?: HeadUnitScreenshotTiming;
}

/**
 * Where captures go: the host temp directory, then `%PUBLIC%` (`C:\Users\Public`, writable by every
 * Windows user and free of spaces) for a temp directory under a profile name with a space.
 */
export function headUnitScreenshotDirectories(
  tmpdir: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const publicDirectory = readEnvTrimmed(AMBIENT_ENV.PUBLIC, env);
  return publicDirectory ? [tmpdir, publicDirectory] : [tmpdir];
}

/**
 * Sends `screenshot <file>` to the DHU console and hashes the PNG once its size stops growing. While
 * the DHU reports no video focus it sends nothing, and a wait it is in ends as soon as the DHU says
 * so, instead of running to the timeout.
 */
export class DhuScreenshotHashSource implements HeadUnitScreenshotSource {
  constructor(
    private readonly dhuConsole: DesktopHeadUnitConsole,
    private readonly deps: DhuScreenshotHashDependencies,
  ) {}

  async hash(signal?: AbortSignal): Promise<string | undefined> {
    if (!this.hasVideoFocus()) {
      return undefined;
    }
    const name = `automobile-head-unit-${this.deps.ids.next()}.png`;
    const file = this.deps.directories
      .map((directory) => path.join(directory, name))
      .find((candidate) => !/\s/.test(candidate));
    if (!file) {
      logger.warn(
        `[AndroidAuto] no head unit screenshot: every capture directory has whitespace (${this.deps.directories.join(", ")}), which the DHU console cannot take`,
      );
      return undefined;
    }
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
      if (!this.hasVideoFocus()) {
        logger.warn(`[AndroidAuto] no head unit screenshot: the DHU has no video focus`);
        return undefined;
      }
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

  /** A console that cannot tell is treated as focused, so the capture is still tried. */
  private hasVideoFocus(): boolean {
    return this.dhuConsole.hasVideoFocus?.() ?? true;
  }
}
