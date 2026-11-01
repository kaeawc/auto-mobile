import { type SharedStorageHashCache, type SharedStorageHashKey } from "./sharedStorageReadService";

const SHARED_STORAGE_HASH_CACHE_MAX_ENTRIES = 2_048;

export class BoundedSharedStorageHashCache implements SharedStorageHashCache {
  private readonly entries = new Map<
    string,
    {
      deviceId: string;
      namespace: string;
      path: string;
      sha256: string;
      lastUsed: number;
    }
  >();
  private accessCounter = 0;

  get(key: SharedStorageHashKey): string | undefined {
    const entry = this.entries.get(hashCacheKey(key));
    if (!entry) {
      return undefined;
    }
    entry.lastUsed = ++this.accessCounter;
    return entry.sha256;
  }

  set(key: SharedStorageHashKey, sha256: string): void {
    const { deviceId, namespace, path } = key;
    for (const [cacheKey, entry] of this.entries) {
      if (entry.deviceId === deviceId && entry.namespace === namespace && entry.path === path) {
        this.entries.delete(cacheKey);
      }
    }
    this.entries.set(hashCacheKey(key), {
      deviceId,
      namespace,
      path,
      sha256,
      lastUsed: ++this.accessCounter,
    });
    while (this.entries.size > SHARED_STORAGE_HASH_CACHE_MAX_ENTRIES) {
      let oldestKey: string | undefined;
      let oldestUsed = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.lastUsed < oldestUsed) {
          oldestKey = key;
          oldestUsed = entry.lastUsed;
        }
      }
      if (oldestKey === undefined) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }

  retainNamespacePaths(deviceId: string, namespace: string, paths: ReadonlySet<string>): void {
    for (const [key, entry] of this.entries) {
      if (entry.deviceId === deviceId && entry.namespace === namespace && !paths.has(entry.path)) {
        this.entries.delete(key);
      }
    }
  }
}

function hashCacheKey({
  deviceId,
  namespace,
  path,
  byteCount,
  modifiedSeconds,
}: SharedStorageHashKey): string {
  return JSON.stringify([deviceId, namespace, path, byteCount, modifiedSeconds]);
}
