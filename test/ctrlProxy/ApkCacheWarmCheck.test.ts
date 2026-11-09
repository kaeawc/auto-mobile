import { beforeEach, describe, expect, test } from "bun:test";
import {
  StatStampApkCacheWarmCheck,
  apkCacheStampPath,
  type ApkCacheStampFileSystem,
} from "../../src/ctrlProxy/ApkCacheWarmCheck";

/** In-memory files with explicit size and mtime, so tests can change one and not the other. */
class FakeStampFileSystem implements ApkCacheStampFileSystem {
  readonly files = new Map<string, { contents: string; size: number; mtimeMs: number }>();
  failWrites = false;

  put(filePath: string, size: number, mtimeMs: number): void {
    this.files.set(filePath, { contents: "", size, mtimeMs });
  }

  async stat(filePath: string): Promise<{ size: number; mtimeMs: number }> {
    const file = this.files.get(filePath);
    if (!file) {
      throw new Error(`ENOENT: ${filePath}`);
    }
    return { size: file.size, mtimeMs: file.mtimeMs };
  }

  async readFile(filePath: string): Promise<string> {
    const file = this.files.get(filePath);
    if (!file) {
      throw new Error(`ENOENT: ${filePath}`);
    }
    return file.contents;
  }

  async writeFile(filePath: string, contents: string): Promise<void> {
    if (this.failWrites) {
      throw new Error("EROFS");
    }
    this.files.set(filePath, { contents, size: contents.length, mtimeMs: 1 });
  }

  async rm(filePath: string): Promise<void> {
    this.files.delete(filePath);
  }
}

describe("StatStampApkCacheWarmCheck", () => {
  const apk = "/cache/control-proxy-abc.apk";
  let fileSystem: FakeStampFileSystem;
  let check: StatStampApkCacheWarmCheck;

  beforeEach(() => {
    fileSystem = new FakeStampFileSystem();
    check = new StatStampApkCacheWarmCheck(fileSystem);
    fileSystem.put(apk, 10_485_760, 1_700_000_000_000);
  });

  test("is cold until a full check records a stamp, then warm", async () => {
    expect(await check.isWarm(apk, "ABC123")).toBe(false);

    await check.recordVerified(apk, "ABC123");

    expect(fileSystem.files.has(apkCacheStampPath(apk))).toBe(true);
    expect(await check.isWarm(apk, "abc123")).toBe(true);
  });

  test("misses when the APK's size or mtime changed since the stamp", async () => {
    await check.recordVerified(apk, "abc");
    fileSystem.put(apk, 10_485_760, 1_700_000_000_001);
    expect(await check.isWarm(apk, "abc")).toBe(false);

    await check.recordVerified(apk, "abc");
    fileSystem.put(apk, 10_485_761, 1_700_000_000_001);
    expect(await check.isWarm(apk, "abc")).toBe(false);
  });

  test("misses when the expected checksum changed", async () => {
    await check.recordVerified(apk, "old");
    expect(await check.isWarm(apk, "new")).toBe(false);
  });

  test("misses when the APK is gone or the stamp is malformed", async () => {
    await check.recordVerified(apk, "abc");
    fileSystem.files.delete(apk);
    expect(await check.isWarm(apk, "abc")).toBe(false);

    fileSystem.put(apk, 10, 10);
    fileSystem.files.set(apkCacheStampPath(apk), { contents: "{not json", size: 9, mtimeMs: 1 });
    expect(await check.isWarm(apk, "abc")).toBe(false);
    fileSystem.files.set(apkCacheStampPath(apk), {
      contents: '{"size":"10"}',
      size: 9,
      mtimeMs: 1,
    });
    expect(await check.isWarm(apk, "abc")).toBe(false);
  });

  test("forget drops the stamp, and a failed stamp write leaves the cache cold", async () => {
    await check.recordVerified(apk, "abc");
    await check.forget(apk);
    expect(await check.isWarm(apk, "abc")).toBe(false);

    fileSystem.failWrites = true;
    await check.recordVerified(apk, "abc");
    expect(await check.isWarm(apk, "abc")).toBe(false);
  });
});
