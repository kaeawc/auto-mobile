import * as fs from "fs/promises";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";

/**
 * Cheap warm-cache test for the published CtrlProxy APK (#17685). A full check parses the
 * zip and hashes the whole APK. After one full check passes, a small stamp file next to
 * the APK records its size, mtime and the checksum it was checked against. A later start
 * whose `stat` still matches that stamp reuses the APK without parsing or hashing it again.
 */
export interface ApkCacheWarmCheck {
  /** True when `cachePath` is unchanged since a full check against `expectedChecksum` passed. */
  isWarm(cachePath: string, expectedChecksum: string): Promise<boolean>;
  /** Record that `cachePath` just passed a full check against `expectedChecksum`. */
  recordVerified(cachePath: string, expectedChecksum: string): Promise<void>;
  /** Drop the stamp for `cachePath`, e.g. after the cached APK was found invalid. */
  forget(cachePath: string): Promise<void>;
}

/** The filesystem calls the stamp check needs; a fake implements it in tests. */
export interface ApkCacheStampFileSystem {
  stat(filePath: string): Promise<{ size: number; mtimeMs: number }>;
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, contents: string): Promise<void>;
  rm(filePath: string): Promise<void>;
}

interface ApkCacheStamp {
  size: number;
  mtimeMs: number;
  checksum: string;
}

const nodeStampFileSystem: ApkCacheStampFileSystem = {
  stat: (filePath) => fs.stat(filePath),
  readFile: (filePath) => fs.readFile(filePath, "utf-8"),
  writeFile: (filePath, contents) => fs.writeFile(filePath, contents, "utf-8"),
  rm: (filePath) => fs.rm(filePath, { force: true }),
};

export function apkCacheStampPath(cachePath: string): string {
  return `${cachePath}.verified.json`;
}

function isApkCacheStamp(value: unknown): value is ApkCacheStamp {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.size === "number" &&
    typeof record.mtimeMs === "number" &&
    typeof record.checksum === "string"
  );
}

export class StatStampApkCacheWarmCheck implements ApkCacheWarmCheck {
  constructor(private readonly fileSystem: ApkCacheStampFileSystem = nodeStampFileSystem) {}

  async isWarm(cachePath: string, expectedChecksum: string): Promise<boolean> {
    try {
      const raw = await this.fileSystem.readFile(apkCacheStampPath(cachePath));
      const stamp: unknown = JSON.parse(raw);
      if (!isApkCacheStamp(stamp)) {
        return false;
      }
      const stats = await this.fileSystem.stat(cachePath);
      return (
        stamp.checksum === expectedChecksum.toLowerCase() &&
        stamp.size === stats.size &&
        stamp.mtimeMs === stats.mtimeMs
      );
    } catch (error) {
      // A missing APK or stamp is the normal cold-cache case; the full check runs instead.
      logger.debug(
        `[CTRL_PROXY] Prefetch warm check missed for ${cachePath}: ${errorMessage(error)}`,
      );
      return false;
    }
  }

  async recordVerified(cachePath: string, expectedChecksum: string): Promise<void> {
    try {
      const stats = await this.fileSystem.stat(cachePath);
      const stamp: ApkCacheStamp = {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        checksum: expectedChecksum.toLowerCase(),
      };
      await this.fileSystem.writeFile(apkCacheStampPath(cachePath), JSON.stringify(stamp));
    } catch (error) {
      // Without a stamp the next start runs the full check again; nothing else depends on it.
      logger.warn(
        `[CTRL_PROXY] Failed to record prefetch cache stamp for ${cachePath}: ${errorMessage(error)}`,
      );
    }
  }

  async forget(cachePath: string): Promise<void> {
    try {
      await this.fileSystem.rm(apkCacheStampPath(cachePath));
    } catch (error) {
      // A leftover stamp cannot match a replaced APK's size and mtime, so it is harmless.
      logger.debug(`[CTRL_PROXY] Failed to remove prefetch cache stamp: ${errorMessage(error)}`);
    }
  }
}
