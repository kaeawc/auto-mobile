import AdmZip from "adm-zip";
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  SCREEN_CAPTURE_HELPER_CACHE_FILENAME,
  SCREEN_CAPTURE_HELPER_METADATA_FILENAME,
  ScreenCaptureHelperProvider,
} from "../../../src/features/screen-stream/ScreenCaptureHelperProvider";
import { logger } from "../../../src/utils/logger";
import { createFileBackedDbHarness, type FileBackedDbHarness } from "../../db/withFileBackedDb";
import { FakeChecksumCalculator } from "../../fakes/FakeChecksumCalculator";
import { FakeFileDownloader } from "../../fakes/FakeFileDownloader";
import { FakeTimer } from "../../fakes/FakeTimer";

const EXPECTED_SHA = "a".repeat(64);
const HELPER_CONTENT = Buffer.from("fake helper bytes; never executed");
const RELEASE_URL = "https://releases.example/helper.zip";

describe("ScreenCaptureHelperProvider cache metadata", () => {
  let tempDirs: FileBackedDbHarness;
  let cacheDir: string;
  let downloader: FakeFileDownloader;
  let checksumCalculator: FakeChecksumCalculator;
  let timer: FakeTimer;
  let archiveBytes: Buffer;
  let rootDir: string;
  let nextCacheDir = 0;

  function makeProvider(): ScreenCaptureHelperProvider {
    return new ScreenCaptureHelperProvider({
      cacheDir,
      downloader,
      checksumCalculator,
      timer,
      expectedChecksum: EXPECTED_SHA,
      releaseUrl: RELEASE_URL,
      env: { AUTOMOBILE_VERSION: "0.0.82" },
      platform: "win32",
    });
  }

  beforeAll(async () => {
    // Build once so compression cost is outside each measured test.
    const archive = new AdmZip();
    archive.addFile(SCREEN_CAPTURE_HELPER_CACHE_FILENAME, HELPER_CONTENT);
    archiveBytes = archive.toBuffer();

    // Reuse only the harness's tracked temp-dir primitive; no DB is opened.
    tempDirs = createFileBackedDbHarness({ env: {} });
    rootDir = await tempDirs.makeTempDbDir("screen-capture-helper-unit-");

    // Bun excludes beforeAll from per-test timing; exercise first-use fs/zlib/AdmZip paths here.
    const warmupDir = path.join(rootDir, "warmup");
    await fs.mkdir(warmupDir);
    const warmupDownloader = new FakeFileDownloader();
    warmupDownloader.payload = archiveBytes;
    const warmupChecksumCalculator = new FakeChecksumCalculator();
    warmupChecksumCalculator.checksum = EXPECTED_SHA;
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    const info = spyOn(logger, "info").mockImplementation(() => {});
    try {
      await new ScreenCaptureHelperProvider({
        cacheDir: warmupDir,
        downloader: warmupDownloader,
        checksumCalculator: warmupChecksumCalculator,
        timer: new FakeTimer(),
        expectedChecksum: EXPECTED_SHA,
        releaseUrl: RELEASE_URL,
        env: { AUTOMOBILE_VERSION: "0.0.82" },
        platform: "win32",
      }).ensure();
    } finally {
      debug.mockRestore();
      info.mockRestore();
    }
  });

  beforeEach(async () => {
    cacheDir = path.join(rootDir, `test-${nextCacheDir++}`);
    await fs.mkdir(cacheDir);
    downloader = new FakeFileDownloader();
    downloader.payload = archiveBytes;
    checksumCalculator = new FakeChecksumCalculator();
    checksumCalculator.checksum = EXPECTED_SHA;
    timer = new FakeTimer();
    await fs.writeFile(path.join(cacheDir, SCREEN_CAPTURE_HELPER_CACHE_FILENAME), HELPER_CONTENT);
  });

  afterAll(async () => {
    await tempDirs.cleanup();
  });

  test.each([
    "{}",
    "null",
    '{"sha256":5}',
    '{"sha256":',
    JSON.stringify({ sha256: EXPECTED_SHA }),
    JSON.stringify({ sha256: EXPECTED_SHA, size: "32" }),
  ])("repairs unusable cache metadata %s by downloading", async (metadata) => {
    const metadataPath = path.join(cacheDir, SCREEN_CAPTURE_HELPER_METADATA_FILENAME);
    await fs.writeFile(metadataPath, metadata);
    const debug = spyOn(logger, "debug").mockImplementation(() => {});

    try {
      const provider = makeProvider();
      const helperPath = await provider.ensure();
      expect(helperPath).toBe(path.join(cacheDir, SCREEN_CAPTURE_HELPER_CACHE_FILENAME));
      expect(downloader.downloadedUrls).toEqual([RELEASE_URL]);
      expect(debug).toHaveBeenCalledWith(
        "[SCREEN_CAPTURE_HELPER] No usable cached helper metadata",
        expect.any(Object),
      );
      expect(JSON.parse(await fs.readFile(metadataPath, "utf8"))).toMatchObject({
        sha256: EXPECTED_SHA,
        size: HELPER_CONTENT.length,
      });
      expect(await fs.readFile(helperPath!, "utf8")).toBe(HELPER_CONTENT.toString());
      expect(await provider.ensure()).toBe(helperPath);
      expect(downloader.downloadedUrls).toHaveLength(1);
      expect(timer.now()).toBe(0);
    } finally {
      debug.mockRestore();
    }
  });

  test("matching metadata reuses the cache without downloading", async () => {
    await fs.writeFile(
      path.join(cacheDir, SCREEN_CAPTURE_HELPER_METADATA_FILENAME),
      JSON.stringify({ sha256: EXPECTED_SHA.toUpperCase(), size: HELPER_CONTENT.length }),
    );

    expect(await makeProvider().ensure()).toBe(
      path.join(cacheDir, SCREEN_CAPTURE_HELPER_CACHE_FILENAME),
    );
    expect(downloader.downloadedUrls).toEqual([]);
    expect(checksumCalculator.computedFiles).toEqual([]);
  });
});
