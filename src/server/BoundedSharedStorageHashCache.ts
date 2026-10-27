import { type SharedStorageHashCache } from "./sharedStorageReadService";

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

  get(
    deviceId: string,
    namespace: string,
    path: string,
    byteCount: number,
    modifiedSeconds: number,
  ): string | undefined {
    const entry = this.entries.get(
      hashCacheKey(deviceId, namespace, path, byteCount, modifiedSeconds),
    );
    if (!entry) {
      return undefined;
    }
    entry.lastUsed = ++this.accessCounter;
    return entry.sha256;
  }

  set(
    deviceId: string,
    namespace: string,
    path: string,
    byteCount: number,
    modifiedSeconds: number,
    sha256: string,
  ): void {
    for (const [key, entry] of this.entries) {
      if (entry.deviceId === deviceId && entry.namespace === namespace && entry.path === path) {
        this.entries.delete(key);
      }
    }
    this.entries.set(hashCacheKey(deviceId, namespace, path, byteCount, modifiedSeconds), {
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

function hashCacheKey(
  deviceId: string,
  namespace: string,
  path: string,
  byteCount: number,
  modifiedSeconds: number,
): string {
  return JSON.stringify([deviceId, namespace, path, byteCount, modifiedSeconds]);
}
