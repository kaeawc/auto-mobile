import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import AdmZip from "adm-zip";
import { randomBytes } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import {
  DefaultCtrlProxyApkPrefetcher,
  type CtrlProxyApkPrefetcherDeps,
} from "../../src/ctrlProxy/CtrlProxyApkPrefetcher";
import { FakeChecksumCalculator } from "../fakes/FakeChecksumCalculator";
import { FakeFileDownloader } from "../fakes/FakeFileDownloader";
import { useScratchRoot } from "../helpers/scratchRoot";
import { apkCacheStampPath } from "../../src/ctrlProxy/ApkCacheWarmCheck";

/** A zip with an AndroidManifest.xml entry and incompressible padding to pass the size floor. */
function fakeApkPayload(): Buffer {
  const zip = new AdmZip();
  zip.addFile("AndroidManifest.xml", Buffer.from("<manifest/>"));
  zip.addFile("classes.dex", randomBytes(12000));
  return zip.toBuffer();
}

describe("DefaultCtrlProxyApkPrefetcher", () => {
  const scratch = useScratchRoot("prefetcher-test-");
  let cacheDir: string;
  let apkPayload: Buffer;
  let downloader: FakeFileDownloader;
  let hasPrerequisites: boolean;

  const createPrefetcher = (overrides: Partial<CtrlProxyApkPrefetcherDeps> = {}) =>
    new DefaultCtrlProxyApkPrefetcher({
      downloader: () => downloader,
      checksumCalculator: () => new FakeChecksumCalculator(),
      prerequisiteDetector: () => ({ hasAndroidPrerequisites: async () => hasPrerequisites }),
      cacheDirOverride: () => cacheDir,
      expectedChecksumOverride: () => "",
      isPinnedVersionUnverifiable: () => false,
      describePinnedVersion: () => "0.0.0-test",
      resolveApkUrl: () => "https://example.test/control-proxy.apk",
      resolveApkChecksum: () => "",
      localApkPathOverride: () => undefined,
      ...overrides,
    });

  beforeAll(() => {
    apkPayload = fakeApkPayload();
  });

  beforeEach(() => {
    cacheDir = scratch.next();
    downloader = new FakeFileDownloader();
    downloader.payload = apkPayload;
    hasPrerequisites = true;
  });

  test("skips without downloading when Android prerequisites are absent", async () => {
    hasPrerequisites = false;
    const prefetcher = createPrefetcher();

    expect(await prefetcher.prefetch()).toBeNull();
    expect(downloader.downloadedUrls).toEqual([]);
    expect(prefetcher.completedPath()).toBeNull();
  });

  test("concurrent prefetches share one download and publish the cached APK", async () => {
    const prefetcher = createPrefetcher();

    const [first, second] = await Promise.all([prefetcher.prefetch(), prefetcher.prefetch()]);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(downloader.downloadedUrls).toEqual(["https://example.test/control-proxy.apk"]);
    expect(prefetcher.completedPath()).toBe(first);
    expect(await prefetcher.getPrefetchedPath()).toBe(first);
  });

  test("a failed download resolves null and a later prefetch retries", async () => {
    const prefetcher = createPrefetcher();
    downloader.shouldThrow = new Error("network down");

    expect(await prefetcher.prefetch()).toBeNull();
    expect(prefetcher.completedPath()).toBeNull();

    downloader.shouldThrow = null;
    expect(await prefetcher.prefetch()).not.toBeNull();
  });

  test("consume copies the prefetched APK and cleanup drops the process-local path", async () => {
    const prefetcher = createPrefetcher();
    const prefetched = await prefetcher.prefetch();
    const destination = path.join(cacheDir, "copies", "control-proxy.apk");

    expect(await prefetcher.consume(destination)).toBe(true);
    expect((await fs.readFile(destination)).equals(await fs.readFile(prefetched as string))).toBe(
      true,
    );

    await prefetcher.cleanup();
    expect(prefetcher.completedPath()).toBeNull();
    expect(await prefetcher.consumeCompleted(destination)).toBe(false);
    expect(await prefetcher.consume(destination)).toBe(false);
  });

  describe("warm cache (#17685)", () => {
    let checksums: FakeChecksumCalculator;
    const createVerifyingPrefetcher = (overrides: Partial<CtrlProxyApkPrefetcherDeps> = {}) =>
      createPrefetcher({
        checksumCalculator: () => checksums,
        expectedChecksumOverride: () => "fake-checksum",
        ...overrides,
      });

    beforeEach(() => {
      checksums = new FakeChecksumCalculator();
    });

    test("a fresh download records a stamp, and the next daemon reuses it without hashing", async () => {
      const first = await createVerifyingPrefetcher().prefetch();
      expect(first).not.toBeNull();
      expect(await fs.readFile(apkCacheStampPath(first as string), "utf-8")).toContain(
        "fake-checksum",
      );
      const hashesAfterDownload = checksums.computedFiles.length;

      const next = createVerifyingPrefetcher();
      expect(await next.prefetch()).toBe(first);
      expect(next.completedPath()).toBe(first);
      expect(checksums.computedFiles.length).toBe(hashesAfterDownload);
      expect(downloader.downloadedUrls).toHaveLength(1);
    });

    test("a cache without a stamp gets the full check once, then is warm", async () => {
      const first = (await createVerifyingPrefetcher().prefetch()) as string;
      await fs.rm(apkCacheStampPath(first));
      const before = checksums.computedFiles.length;

      expect(await createVerifyingPrefetcher().prefetch()).toBe(first);
      expect(checksums.computedFiles.length).toBe(before + 1);
      expect(await createVerifyingPrefetcher().prefetch()).toBe(first);
      expect(checksums.computedFiles.length).toBe(before + 1);
      expect(downloader.downloadedUrls).toHaveLength(1);
    });

    test("AUTOMOBILE_EAGER_PREFETCH mode runs the full check on a warm cache", async () => {
      const first = await createVerifyingPrefetcher().prefetch();
      const before = checksums.computedFiles.length;

      const eager = createVerifyingPrefetcher({ forceFullVerification: () => true });
      expect(await eager.prefetch()).toBe(first);
      expect(checksums.computedFiles.length).toBe(before + 1);
    });

    test("a changed checksum misses the stamp and downloads again", async () => {
      await createVerifyingPrefetcher().prefetch();
      checksums.checksum = "new-checksum";

      const next = createVerifyingPrefetcher({ expectedChecksumOverride: () => "new-checksum" });
      expect(await next.prefetch()).not.toBeNull();
      expect(downloader.downloadedUrls).toHaveLength(2);
    });

    test("a cached APK rewritten in place misses the stamp and is rechecked in full", async () => {
      const first = (await createVerifyingPrefetcher().prefetch()) as string;
      await fs.writeFile(first, Buffer.concat([apkPayload, Buffer.from("x")]));
      const before = checksums.computedFiles.length;

      expect(await createVerifyingPrefetcher().prefetch()).toBe(first);
      expect(checksums.computedFiles.length).toBe(before + 1);
    });
  });
});
