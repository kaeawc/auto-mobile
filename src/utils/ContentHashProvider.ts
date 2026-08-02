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

  /**
   * Drop every cached hash for `(deviceId, packageId)` across all versionCodes, so
   * the next resolution recomputes. Called on a package update/reinstall/removal —
   * a same-versionCode rebuild with different content must not reuse the old hash.
   */
  invalidate(deviceId: string, packageId: string): void;
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
  // Per-(device,package) generation, bumped by invalidate(). A computeHash that
  // started before an invalidate must NOT repopulate the cache with a stale hash,
  // so a result is only cached when the generation is unchanged since it began.
  private readonly generation = new Map<string, number>();

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
    const genKey = `${device.deviceId}::${packageId}`;
    const startGeneration = this.generation.get(genKey) ?? 0;
    try {
      const hash = await this.hasher.computeHash(device, packageId, versionCode);
      // Only cache if the package wasn't invalidated (updated/reinstalled) while
      // this computation was in flight — otherwise the entry would be stale.
      if ((this.generation.get(genKey) ?? 0) === startGeneration) {
        this.cache.set(key, hash);
      }
      return hash;
    } catch (error) {
      // Best-effort: log and fall back to the default build key (never hard-fail).
      logger.warn(`[ContentHash] Failed to hash ${packageId} on ${device.deviceId}: ${error}`, error);
      return null;
    }
  }

  invalidate(deviceId: string, packageId: string): void {
    const genKey = `${deviceId}::${packageId}`;
    this.generation.set(genKey, (this.generation.get(genKey) ?? 0) + 1);
    const prefix = `${genKey}::`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * Combine per-APK SHA-256 digests (from `sha256sum` output: `<hex>  <path>` per
 * line) into a single content hash. Sorted so split-APK ordering does not affect
 * the result, and derived from digests only (no filesystem timestamps/metadata).
 *
 * Only lines whose first token is a valid 64-char hex SHA-256 are used; other
 * lines (e.g. a legacy `adb shell` merging `sha256sum: not found` into stdout) are
 * ignored. Returns `""` when no valid digest is present, so the caller can fall
 * back to the pull path instead of caching a meaningless hash.
 */
export function combineApkDigests(sha256sumStdout: string): string {
  const digests = sha256sumStdout
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => line.split(/\s+/)[0])
    .filter((digest): digest is string => Boolean(digest) && SHA256_HEX.test(digest))
    .sort();
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
    .map(line => line.trim())
    .filter(line => line.startsWith("package:"))
    .map(line => line.slice("package:".length).trim())
    .filter(path => path.endsWith(".apk"))
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
    private readonly adb: AdbExecutor,
    private readonly checksum: ChecksumCalculator = new DefaultChecksumCalculator()
  ) {}

  async computeHash(_device: BootedDevice, packageId: string): Promise<string> {
    const apkPaths = await this.resolveApkPaths(packageId);
    if (apkPaths.length === 0) {
      throw toActionableError(
        new Error(`pm path returned no APKs for ${packageId}`),
        `Cannot resolve APK path for ${packageId}`
      );
    }

    // On-device digest of every APK. Guard both the throw case (modern adb
    // propagates a non-zero exit when sha256sum is absent) and the empty/garbage
    // -stdout case, so the pull fallback is reachable and a "sha256sum: not found"
    // line (a legacy adb can merge stderr into stdout) is never hashed as a digest.
    let combined = "";
    try {
      const script = apkPaths.map(p => `sha256sum "${p}"`).join("; ");
      const onDevice = await this.adb.executeCommand(`shell sh -c '${script}'`);
      combined = combineApkDigests(onDevice.stdout ?? "");
    } catch (error) {
      logger.debug(`[ContentHash] on-device sha256sum failed for ${packageId}: ${error}`);
    }
    if (combined) {
      return combined;
    }

    logger.warn(`[ContentHash] on-device sha256sum unavailable for ${packageId}; using adb pull (slow path)`);
    return this.computeViaPull(apkPaths, packageId);
  }

  private async resolveApkPaths(packageId: string): Promise<string[]> {
    const listing = await this.adb.executeCommand(`shell pm path ${packageId}`);
    return parsePmPathOutput(listing.stdout ?? "");
  }

  private async computeViaPull(remotePaths: string[], packageId: string): Promise<string> {
    const workDir = await fs.mkdtemp(join(tmpdir(), "automobile-apk-"));
    try {
      const digests: string[] = [];
      for (const remote of remotePaths) {
        const localPath = join(workDir, `${digests.length}.apk`);
        await this.adb.executeCommand(`pull "${remote}" "${localPath}"`);
        const { checksum } = await this.checksum.computeFileSha256(localPath);
        digests.push(`${checksum}  ${remote}`);
      }
      const combined = combineApkDigests(digests.join("\n"));
      if (!combined) {
        throw toActionableError(
          new Error(`No valid APK digests computed for ${packageId}`),
          `Cannot hash APKs for ${packageId}`
        );
      }
      return combined;
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
  if (device.platform === "android") {
    return new CachingContentHashProvider(
      new AndroidApkContentHasher(adbFactory.create(device))
    );
  }
  const metadata = new GetAppMetadata(device, adbFactory, iosSource);
  return new CachingContentHashProvider(new IosBundleContentHasher(metadata));
}
