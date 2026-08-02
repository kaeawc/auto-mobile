import { createHash } from "crypto";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { BootedDevice } from "../models";
import type { AdbExecutor } from "./android-cmdline-tools/interfaces/AdbExecutor";
import { GetAppMetadata, type IosAppMetadataSource } from "../features/observe/GetAppMetadata";
import { hashAppBundle } from "./ios-cmdline-tools/AppBundleHasher";
import { DefaultChecksumCalculator, type ChecksumCalculator } from "./ChecksumCalculator";
import { AdbClientFactory, defaultAdbClientFactory } from "./android-cmdline-tools/AdbClientFactory";
import { toActionableError } from "../models/ActionableError";
import { logger } from "./logger";

/**
 * Derives the content hash of an installed app from its installed bytes (#4984).
 *
 * The hash must be identical for identical content across reinstalls/rebuilds, so
 * it is derived from APK/IPA bytes only — never from install-time signals such as
 * Android `lastUpdateTime`. Resolution returns `null` on failure so the caller
 * records provenance under the default build key instead of hard-failing.
 */
export interface ContentHashProvider {
  resolveContentHash(
    device: BootedDevice,
    packageId: string,
    versionCode: number
  ): Promise<string | null>;
}

/**
 * Platform-specific step that hashes the installed app's bytes. Injected so the
 * caching + fallback contract in {@link CachingContentHashProvider} is unit-tested
 * with a fake; the real Android/iOS implementations are integration-only.
 */
export interface AppContentHasher {
  computeHash(device: BootedDevice, packageId: string, versionCode: number): Promise<string>;
}

/**
 * Caches by `(deviceId, packageId, versionCode)` (computed once per install) and
 * degrades to `null` on any hashing failure so a mutation never blocks on — or
 * fails because of — content hashing.
 */
export class CachingContentHashProvider implements ContentHashProvider {
  private readonly cache = new Map<string, string>();

  constructor(private readonly hasher: AppContentHasher) {}

  async resolveContentHash(
    device: BootedDevice,
    packageId: string,
    versionCode: number
  ): Promise<string | null> {
    const key = `${device.deviceId}::${packageId}::${versionCode}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const hash = await this.hasher.computeHash(device, packageId, versionCode);
      this.cache.set(key, hash);
      return hash;
    } catch (error) {
      // Best-effort: log and fall back to the default build key (never hard-fail).
      logger.warn(`[ContentHash] Failed to hash ${packageId} on ${device.deviceId}: ${error}`, error);
      return null;
    }
  }
}

/**
 * Combine per-APK SHA-256 digests (from `sha256sum` output: `<hex>  <path>` per
 * line) into a single content hash. Sorted so split-APK ordering does not affect
 * the result, and derived from digests only (no filesystem timestamps/metadata).
 */
export function combineApkDigests(sha256sumStdout: string): string {
  const digests = sha256sumStdout
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => line.split(/\s+/)[0])
    .filter((digest): digest is string => Boolean(digest))
    .sort();
  const hash = createHash("sha256");
  for (const digest of digests) {
    hash.update(digest);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Android: hash the installed APK set. Prefers on-device `sha256sum` (no byte
 * transfer); falls back to `adb pull` + local hashing when `sha256sum` is absent.
 * Uses `codePath` (the installed APK directory) — never `lastUpdateTime`.
 */
export class AndroidApkContentHasher implements AppContentHasher {
  constructor(
    private readonly adb: AdbExecutor,
    private readonly metadata: GetAppMetadata,
    private readonly checksum: ChecksumCalculator = new DefaultChecksumCalculator()
  ) {}

  async computeHash(_device: BootedDevice, packageId: string): Promise<string> {
    const meta = await this.metadata.execute(packageId);
    const codePath = meta?.installPath;
    if (!codePath) {
      throw toActionableError(
        new Error(`No installPath (codePath) for ${packageId}`),
        `Cannot resolve APK path for ${packageId}`
      );
    }

    // On-device digest of every .apk in the code path (base + splits).
    const onDevice = await this.adb.executeCommand(
      `shell sh -c 'for f in "${codePath}"/*.apk; do sha256sum "$f"; done'`
    );
    const stdout = onDevice.stdout ?? "";
    const stderr = onDevice.stderr ?? "";
    const sha256sumMissing = /not found|no such tool|inaccessible|permission denied/i.test(stderr);
    if (stdout.trim() && !sha256sumMissing) {
      return combineApkDigests(stdout);
    }

    logger.warn(`[ContentHash] on-device sha256sum unavailable for ${packageId}; using adb pull (slow path)`);
    return this.computeViaPull(codePath, packageId);
  }

  private async computeViaPull(codePath: string, packageId: string): Promise<string> {
    const listing = await this.adb.executeCommand(`shell ls "${codePath}"/*.apk`);
    const remotePaths = (listing.stdout ?? "")
      .split("\n")
      .map(p => p.trim())
      .filter(p => p.endsWith(".apk"))
      .sort();
    if (remotePaths.length === 0) {
      throw toActionableError(
        new Error(`No APK files under ${codePath}`),
        `Cannot hash APKs for ${packageId}`
      );
    }

    const workDir = await fs.mkdtemp(join(tmpdir(), "automobile-apk-"));
    try {
      const digests: string[] = [];
      for (const remote of remotePaths) {
        const localPath = join(workDir, `${digests.length}.apk`);
        await this.adb.executeCommand(`pull "${remote}" "${localPath}"`);
        const { checksum } = await this.checksum.computeFileSha256(localPath);
        digests.push(`${checksum}  ${remote}`);
      }
      return combineApkDigests(digests.join("\n"));
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }
}

/**
 * iOS: hash the installed app bundle bytes via the shared {@link hashAppBundle}
 * (which already excludes signature/provisioning files, so re-signing identical
 * content yields the same hash). Simulator bundles are host-filesystem dirs.
 */
export class IosBundleContentHasher implements AppContentHasher {
  constructor(private readonly metadata: GetAppMetadata) {}

  async computeHash(_device: BootedDevice, packageId: string): Promise<string> {
    const meta = await this.metadata.execute(packageId);
    const bundlePath = meta?.installPath;
    if (!bundlePath) {
      throw toActionableError(
        new Error(`No bundlePath for ${packageId}`),
        `Cannot resolve app bundle path for ${packageId}`
      );
    }
    return hashAppBundle(bundlePath);
  }
}

/**
 * Build a caching content-hash provider for a device, picking the platform hasher.
 */
export function createContentHashProvider(
  device: BootedDevice,
  adbFactory: AdbClientFactory = defaultAdbClientFactory,
  iosSource: IosAppMetadataSource | null = null
): ContentHashProvider {
  const metadata = new GetAppMetadata(device, adbFactory, iosSource);
  if (device.platform === "android") {
    return new CachingContentHashProvider(
      new AndroidApkContentHasher(adbFactory.create(device), metadata)
    );
  }
  return new CachingContentHashProvider(new IosBundleContentHasher(metadata));
}
