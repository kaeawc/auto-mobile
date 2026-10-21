import { createHash } from "crypto";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { BootedDevice } from "../models";
import type { AdbExecutor } from "./android-cmdline-tools/interfaces/AdbExecutor";
import { DefaultChecksumCalculator, type ChecksumCalculator } from "./ChecksumCalculator";
import { toActionableError } from "../models/ActionableError";
import { logger } from "./logger";
import { shellQuote } from "./shellQuote";
import type { AppContentHasher } from "./ContentHashProvider";

export const APK_PULL_TIMEOUT_MS = 120_000;

export const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * Extract the valid 64-char hex SHA-256 digests from `sha256sum` output
 * (`<hex>  <path>` per line), sorted. Lines whose first token is not a valid hex
 * digest — e.g. a legacy `adb shell` merging `sha256sum: not found` into stdout, or
 * a per-file error for an unreadable split — are dropped, so the caller can compare
 * the count against the expected number of APKs.
 */
export function extractApkDigests(sha256sumStdout: string): string[] {
  return sha256sumStdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/)[0])
    .filter((digest): digest is string => Boolean(digest) && SHA256_HEX.test(digest))
    .sort();
}

/**
 * Combine per-APK SHA-256 digests into a single content hash. Sorted so split-APK
 * ordering does not affect the result, and derived from digests only (no filesystem
 * timestamps/metadata). Returns `""` when no valid digest is present.
 */
export function combineApkDigests(sha256sumStdout: string): string {
  return hashDigestList(extractApkDigests(sha256sumStdout));
}

export function hashDigestList(digests: string[]): string {
  if (digests.length === 0) {
    return "";
  }
  const hash = createHash("sha256");
  for (const digest of digests) {
    hash.update(digest);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Parse `adb shell pm path <pkg>` output into the installed APK paths (base + splits). */
export function parsePmPathOutput(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("package:"))
    .map((line) => line.slice("package:".length).trim())
    .filter((path) => path.endsWith(".apk"))
    .sort();
}

/**
 * Android: hash the installed APK set (base + splits). APK paths come from
 * `pm path <pkg>` — which works on every path, unlike `GetAppMetadata.installPath`
 * that is empty when the WebSocket PackageManager call succeeds (only the dumpsys
 * fallback populates `codePath`). Prefers on-device `sha256sum` (no byte transfer);
 * falls back to `adb pull` + local hashing when `sha256sum` is absent. Derived from
 * APK bytes only — never `lastUpdateTime`. versionCode is a cache key, not hashed.
 */
export class AndroidApkContentHasher implements AppContentHasher {
  constructor(
    private readonly adb: Pick<AdbExecutor, "executeCommand">,
    private readonly checksum: ChecksumCalculator = new DefaultChecksumCalculator(),
  ) {}

  async computeHash(_device: BootedDevice, packageId: string): Promise<string> {
    const apkPaths = await this.resolveApkPaths(packageId);
    if (apkPaths.length === 0) {
      throw toActionableError(
        new Error(`pm path returned no APKs for ${packageId}`),
        `Cannot resolve APK path for ${packageId}`,
      );
    }

    // On-device digest of every APK. Require exactly ONE valid digest per APK path:
    // the `;`-joined commands let one split fail (unreadable / sha256sum absent) while
    // another still prints a valid digest, and accepting that partial hash would
    // conflate builds differing only in the failing split. A count mismatch (also the
    // throw case — modern adb propagates a non-zero exit — and the "sha256sum: not
    // found" merged-stderr case) falls back to the pull path.
    let digests: string[] = [];
    try {
      const script = apkPaths.map((p) => `sha256sum ${shellQuote(p)}`).join("; ");
      const onDevice = await this.adb.executeCommand(`shell sh -c ${shellQuote(script)}`);
      digests = extractApkDigests(onDevice.stdout);
    } catch (error) {
      logger.debug(`[ContentHash] on-device sha256sum failed for ${packageId}: ${error}`);
    }
    if (digests.length === apkPaths.length) {
      return combineApkDigests(digests.join("\n"));
    }

    logger.warn(
      `[ContentHash] on-device sha256sum incomplete for ${packageId} ` +
        `(${digests.length}/${apkPaths.length} APKs); using adb pull (slow path)`,
    );
    return this.computeViaPull(apkPaths, packageId);
  }

  private async resolveApkPaths(packageId: string): Promise<string[]> {
    const listing = await this.adb.executeCommand(`shell pm path ${shellQuote(packageId)}`);
    return parsePmPathOutput(listing.stdout);
  }

  private async computeViaPull(remotePaths: string[], packageId: string): Promise<string> {
    const workDir = await fs.mkdtemp(join(tmpdir(), "automobile-apk-"));
    try {
      const digests: string[] = [];
      for (const remote of remotePaths) {
        const localPath = join(workDir, `${digests.length}.apk`);
        await this.adb.executeCommand(`pull "${remote}" "${localPath}"`, {
          timeoutMs: APK_PULL_TIMEOUT_MS,
        });
        const { checksum } = await this.checksum.computeFileSha256(localPath);
        digests.push(`${checksum}  ${remote}`);
      }
      const combined = combineApkDigests(digests.join("\n"));
      if (!combined) {
        throw toActionableError(
          new Error(`No valid APK digests computed for ${packageId}`),
          `Cannot hash APKs for ${packageId}`,
        );
      }
      return combined;
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }
}
