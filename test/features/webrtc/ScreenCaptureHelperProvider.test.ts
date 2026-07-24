import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SCREEN_CAPTURE_HELPER_FILENAME } from "../../../src/constants/release";
import {
  SCREEN_CAPTURE_HELPER_METADATA_FILENAME,
  ScreenCaptureHelperProvider,
  type ScreenCaptureHelperMetadata,
} from "../../../src/features/webrtc/ScreenCaptureHelperProvider";
import { FakeChecksumCalculator } from "../../fakes/FakeChecksumCalculator";
import { FakeFileDownloader } from "../../fakes/FakeFileDownloader";
import { FakeTimer } from "../../fakes/FakeTimer";

const EXPECTED_SHA = "a".repeat(64);

describe("ScreenCaptureHelperProvider (#4392)", function() {
  let cacheDir: string;
  let downloader: FakeFileDownloader;
  let checksum: FakeChecksumCalculator;
  let timer: FakeTimer;

  function makeProvider(): ScreenCaptureHelperProvider {
    return new ScreenCaptureHelperProvider({
      downloader,
      checksumCalculator: checksum,
      cacheDir,
      timer,
      // Pin so resolveScreenCaptureHelperUrl produces a concrete URL; the fake
      // downloader ignores it. Checksum is forced via setExpectedChecksumForTesting.
      env: { AUTOMOBILE_VERSION: "latest" },
    });
  }

  beforeEach(async function() {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-helper-test-"));
    downloader = new FakeFileDownloader();
    downloader.payload = Buffer.from("fake-universal-mach-o-helper");
    checksum = new FakeChecksumCalculator();
    checksum.checksum = EXPECTED_SHA;
    timer = new FakeTimer();
    timer.setCurrentTime(1000);
    ScreenCaptureHelperProvider.resetInstances();
    ScreenCaptureHelperProvider.setExpectedChecksumForTesting(EXPECTED_SHA);
  });

  afterEach(async function() {
    ScreenCaptureHelperProvider.resetInstances();
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  test("downloads, verifies, caches, and marks the helper executable", async function() {
    const helperPath = await makeProvider().ensure();

    expect(helperPath).toBe(path.join(cacheDir, SCREEN_CAPTURE_HELPER_FILENAME));
    expect(downloader.downloadedUrls).toHaveLength(1);
    expect(downloader.downloadedUrls[0]).toContain(SCREEN_CAPTURE_HELPER_FILENAME);

    const stats = await fs.stat(helperPath!);
    expect(stats.isFile()).toBe(true);
    // The cached executable must carry the owner-execute bit — it is spawned
    // directly, and curl/npm do not preserve an executable bit. Windows has no
    // Unix mode bits (chmod is a no-op there) and never runs the macOS helper,
    // so this assertion only applies off Windows.
    if (process.platform !== "win32") {
      expect(stats.mode & 0o100).toBe(0o100);
    }

    const meta = JSON.parse(
      await fs.readFile(path.join(cacheDir, SCREEN_CAPTURE_HELPER_METADATA_FILENAME), "utf8")
    ) as ScreenCaptureHelperMetadata;
    expect(meta.sha256).toBe(EXPECTED_SHA);
    expect(meta.version).toBe("latest");
    expect(meta.downloadedAt).toBe(1000);
    expect(meta.size).toBe(stats.size);
  });

  test("reuses a valid cache without re-downloading", async function() {
    await makeProvider().ensure();
    expect(downloader.downloadedUrls).toHaveLength(1);

    const helperPath = await makeProvider().ensure();
    expect(helperPath).toBe(path.join(cacheDir, SCREEN_CAPTURE_HELPER_FILENAME));
    expect(downloader.downloadedUrls).toHaveLength(1);
  });

  test("invalidates the cache and re-downloads when the on-disk size no longer matches the sidecar", async function() {
    const helperPath = (await makeProvider().ensure())!;
    expect(downloader.downloadedUrls).toHaveLength(1);

    await fs.writeFile(helperPath, Buffer.from("truncated"));

    const reFetched = await makeProvider().ensure();
    expect(reFetched).toBe(helperPath);
    expect(downloader.downloadedUrls).toHaveLength(2);
  });

  test("re-downloads when the cached sha no longer matches the expected sha", async function() {
    await makeProvider().ensure();

    const newSha = "b".repeat(64);
    ScreenCaptureHelperProvider.setExpectedChecksumForTesting(newSha);
    checksum.checksum = newSha;

    const helperPath = await makeProvider().ensure();
    expect(helperPath).not.toBeNull();
    expect(downloader.downloadedUrls).toHaveLength(2);
  });

  test("rejects a checksum mismatch and leaves no cached file", async function() {
    checksum.checksum = "c".repeat(64); // differs from the forced expected sha
    await expect(makeProvider().ensure()).rejects.toThrow(/checksum verification failed/);
    await expect(
      fs.access(path.join(cacheDir, SCREEN_CAPTURE_HELPER_FILENAME))
    ).rejects.toThrow();
  });

  test("returns null (degrade) when the expected checksum is unknown, without touching the network", async function() {
    ScreenCaptureHelperProvider.setExpectedChecksumForTesting("");
    const helperPath = await makeProvider().ensure();
    expect(helperPath).toBeNull();
    expect(downloader.downloadedUrls).toHaveLength(0);
  });

  test("single-flight: concurrent ensure() calls share one download", async function() {
    const provider = makeProvider();
    const [a, b] = await Promise.all([provider.ensure(), provider.ensure()]);
    expect(a).toBe(b!);
    expect(downloader.downloadedUrls).toHaveLength(1);
  });
});
