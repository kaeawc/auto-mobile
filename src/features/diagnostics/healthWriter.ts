import fs from "fs";
import path from "path";
import os from "os";
import { logger } from "../../utils/logger";
import { buildHealthFilename, resolveHealthDir } from "./healthLocator";
import type { RunHealthSummary } from "./types";


export interface HealthWriterFs {
  mkdirSync(p: string, options: { recursive: boolean }): void;
  writeFileSync(p: string, contents: string, encoding: BufferEncoding): void;
}


export interface HealthWriter {
  write(summary: RunHealthSummary): string | null;
}


export interface DefaultHealthWriterOptions {
  envValue?: string | undefined;
  homeDir?: string;
  fs?: HealthWriterFs;
  /** Test seam: override the random suffix used for ad-hoc filenames. */
  randomSuffix?: () => string;
}


/**
 * Real-fs implementation of the locator + writer. Errors during write are
 * swallowed with a `logger.warn` so a malformed CI environment never fails
 * the surrounding plan execution — observability must not be load-bearing.
 */
export class DefaultHealthWriter implements HealthWriter {

  private readonly envValue: string | undefined;

  private readonly homeDir: string;

  private readonly fs: HealthWriterFs;

  private readonly randomSuffix: () => string;


  constructor(options: DefaultHealthWriterOptions = {}) {
    this.envValue = options.envValue ?? process.env.AUTOMOBILE_HEALTH_DIR;
    this.homeDir = options.homeDir ?? os.homedir();
    this.fs = options.fs ?? defaultHealthWriterFs;
    this.randomSuffix = options.randomSuffix ?? defaultRandomSuffix;
  }


  write(summary: RunHealthSummary): string | null {
    try {
      const dir = resolveHealthDir({
        envValue: this.envValue,
        homeDir: this.homeDir,
      });
      this.fs.mkdirSync(dir, { recursive: true });
      const filename = buildHealthFilename(
        summary.sessionId,
        new Date(summary.startedAt),
        this.randomSuffix()
      );
      const fullPath = path.join(dir, filename);
      this.fs.writeFileSync(fullPath, JSON.stringify(summary, null, 2), "utf-8");
      logger.info(`[HEALTH] Run health summary written: ${fullPath}`);
      return fullPath;
    } catch (error) {
      logger.warn(
        `[HEALTH] Failed to write run health summary: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }
}


function defaultRandomSuffix(): string {
  // 8 hex chars is plenty for "two unrelated ad-hoc runs in the same ms" collision avoidance.
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}


const defaultHealthWriterFs: HealthWriterFs = {
  mkdirSync: (p, options) => fs.mkdirSync(p, { ...options, mode: 0o700 }),
  writeFileSync: (p, contents, encoding) => fs.writeFileSync(p, contents, {
    encoding,
    flag: "wx",
    mode: 0o600,
  }),
};
