import type { BootedDevice } from "../models";
import type { AdbExecutor } from "./android-cmdline-tools/interfaces/AdbExecutor";
import { IosAppMetadataReader } from "./IosAppMetadataReader";
import type { IosAppMetadataSource } from "../models/IosAppMetadataSource";
import { defaultAdbClientFactory } from "./android-cmdline-tools/AdbClientFactory";
import { logger } from "./logger";
import { IosBundleContentHasher } from "./IosBundleContentHasher";
import { AndroidApkContentHasher } from "./AndroidApkContentHasher";
export {
  AndroidApkContentHasher,
  combineApkDigests,
  parsePmPathOutput,
} from "./AndroidApkContentHasher";
export { IosBundleContentHasher } from "./IosBundleContentHasher";

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
    versionCode: number | string,
  ): Promise<string | null>;

  /**
   * Drop every cached hash for `(deviceId, packageId)` across all numeric/string versions, so
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
  computeHash(
    device: BootedDevice,
    packageId: string,
    versionCode: number | string,
  ): Promise<string>;
}

/**
 * Caches by `(deviceId, packageId, numeric/string version)` (computed once per install) and
 * degrades to `null` on any hashing failure so a mutation never blocks on — or
 * fails because of — content hashing.
 *
 * Overlapping `resolveContentHash` calls for the same key are NOT coalesced here:
 * the sole runtime caller, `AndroidCtrlProxyClient.ensureBuildContext`, already
 * admits one resolution per app (`buildContextInFlight`) at the outer boundary that
 * also covers the package-info round-trip, so a provider-level single-flight never
 * observed a second concurrent caller (#6892, superseding #6654). Overlapping calls
 * remain safe — each computes and the generation guard keeps stale results out of
 * the cache — just not deduplicated.
 */
export class CachingContentHashProvider implements ContentHashProvider {
  // Indexed by the invalidation key `(deviceId, packageId)` first, then versionCode,
  // so invalidate() drops exactly that package's entries instead of scanning every
  // cached key on the device (#6892).
  private readonly cache = new Map<string, Map<number | string, string>>();
  // Per-(device,package) generation, bumped by invalidate(). A computeHash that
  // started before an invalidate must NOT repopulate the cache with a stale hash,
  // so a result is only cached when the generation is unchanged since it began.
  private readonly generation = new Map<string, number>();

  constructor(private readonly hasher: AppContentHasher) {}

  async resolveContentHash(
    device: BootedDevice,
    packageId: string,
    versionCode: number | string,
  ): Promise<string | null> {
    const genKey = packageKey(device.deviceId, packageId);
    const cached = this.cache.get(genKey)?.get(versionCode);
    if (cached !== undefined) {
      return cached;
    }
    const startGeneration = this.generation.get(genKey) ?? 0;
    try {
      const hash = await this.hasher.computeHash(device, packageId, versionCode);
      // Only cache if the package wasn't invalidated (updated/reinstalled) while
      // this computation was in flight — otherwise the entry would be stale.
      if ((this.generation.get(genKey) ?? 0) === startGeneration) {
        this.cacheHash(genKey, versionCode, hash);
      }
      return hash;
    } catch (error) {
      // Best-effort: log and fall back to the default build key (never hard-fail).
      logger.warn(
        `[ContentHash] Failed to hash ${packageId} on ${device.deviceId}: ${error}`,
        error,
      );
      return null;
    }
  }

  private cacheHash(genKey: string, versionCode: number | string, hash: string): void {
    const byVersion = this.cache.get(genKey) ?? new Map<number | string, string>();
    byVersion.set(versionCode, hash);
    this.cache.set(genKey, byVersion);
  }

  invalidate(deviceId: string, packageId: string): void {
    const genKey = packageKey(deviceId, packageId);
    this.generation.set(genKey, (this.generation.get(genKey) ?? 0) + 1);
    // Every versionCode for this (device, package) lives under one index entry, so
    // this is O(1) in the number of other cached packages.
    this.cache.delete(genKey);
  }
}

function packageKey(deviceId: string, packageId: string): string {
  return `${deviceId}::${packageId}`;
}

/**
 * Build a caching content-hash provider for a device, picking the platform hasher.
 *
 * The Android hasher runs on the supplied `AdbExecutor` — callers MUST pass their
 * injected executor (e.g. a CtrlProxy client's `this.adb`) so tests with a fake adb
 * never launch a real `adb` subprocess and custom production executors aren't
 * bypassed. Defaults to the real factory only when no executor is given.
 */
export function createContentHashProvider(
  device: BootedDevice,
  adb: AdbExecutor = defaultAdbClientFactory.create(device),
  iosSource: IosAppMetadataSource | null = null,
): ContentHashProvider {
  if (device.platform === "android") {
    return new CachingContentHashProvider(new AndroidApkContentHasher(adb));
  }
  // iOS resolves the bundle path via iosSource (adb is unused for iOS metadata).
  const metadata = new IosAppMetadataReader(device, iosSource);
  return new CachingContentHashProvider(new IosBundleContentHasher(metadata));
}
