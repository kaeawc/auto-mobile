import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SCREEN_CAPTURE_HELPER_ARCHIVE_FILENAME,
  SCREEN_CAPTURE_HELPER_CACHE_FILENAME,
  SCREEN_CAPTURE_HELPER_DOWNLOAD_TIMEOUT_MS,
  SCREEN_CAPTURE_HELPER_METADATA_FILENAME,
  ScreenCaptureHelperProvider,
  type ScreenCaptureHelperMetadata,
} from "../../../src/features/screen-stream/ScreenCaptureHelperProvider";
import { FakeChecksumCalculator } from "../../fakes/FakeChecksumCalculator";
import { FakeFileDownloader } from "../../fakes/FakeFileDownloader";
import { FakeTimer } from "../../fakes/FakeTimer";

const EXPECTED_SHA = "a".repeat(64);

function helperArchive(): Buffer {
  const archive = new AdmZip();
  archive.addFile(SCREEN_CAPTURE_HELPER_CACHE_FILENAME, Buffer.from("signed-universal-helper"));
  return archive.toBuffer();
}

describe("ScreenCaptureHelperProvider", () => {
  let cacheDir: string;
  let downloader: FakeFileDownloader;
  let checksumCalculator: FakeChecksumCalculator;
  let timer: FakeTimer;

  function makeProvider(
    expectedChecksum = EXPECTED_SHA,
    platform?: NodeJS.Platform,
  ): ScreenCaptureHelperProvider {
    return new ScreenCaptureHelperProvider({
      cacheDir,
      downloader,
      checksumCalculator,
      timer,
      expectedChecksum,
      releaseUrl: `https://releases.example/0.0.46/${SCREEN_CAPTURE_HELPER_ARCHIVE_FILENAME}`,
      env: { AUTOMOBILE_VERSION: "0.0.46" },
      platform,
    });
  }

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "screen-capture-helper-test-"));
    downloader = new FakeFileDownloader();
    downloader.payload = helperArchive();
    checksumCalculator = new FakeChecksumCalculator();
    checksumCalculator.checksum = EXPECTED_SHA;
    timer = new FakeTimer();
    timer.setCurrentTime(1000);
    ScreenCaptureHelperProvider.resetInstances();
  });

  afterEach(async () => {
    ScreenCaptureHelperProvider.resetInstances();
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  test("allows a cold release download a network-appropriate deadline", () => {
    expect(SCREEN_CAPTURE_HELPER_DOWNLOAD_TIMEOUT_MS).toBe(30_000);
  });

  test("downloads, verifies, extracts, and caches the release helper", async () => {
    const helperPath = await makeProvider().ensure();

    expect(helperPath).toBe(path.join(cacheDir, SCREEN_CAPTURE_HELPER_CACHE_FILENAME));
    expect(await fs.readFile(helperPath!, "utf8")).toBe("signed-universal-helper");
    expect(downloader.downloadedUrls).toEqual([
      `https://releases.example/0.0.46/${SCREEN_CAPTURE_HELPER_ARCHIVE_FILENAME}`,
    ]);
    const metadata = JSON.parse(
      await fs.readFile(path.join(cacheDir, SCREEN_CAPTURE_HELPER_METADATA_FILENAME), "utf8"),
    ) as ScreenCaptureHelperMetadata;
    expect(metadata).toMatchObject({
      version: "0.0.46",
      sha256: EXPECTED_SHA,
      downloadedAt: 1000,
    });
  });

  test("reuses a verified cached helper without downloading again", async () => {
    const provider = makeProvider();
    const first = await provider.ensure();
    const second = await makeProvider().ensure();

    expect(second).toBe(first);
    expect(downloader.downloadedUrls).toHaveLength(1);
  });

  test("reuses a verified cached helper on Windows without POSIX execute bits", async () => {
    const provider = makeProvider(EXPECTED_SHA, "win32");
    const first = await provider.ensure();
    await fs.chmod(first!, 0o600);
    const second = await makeProvider(EXPECTED_SHA, "win32").ensure();

    expect(second).toBe(first);
    expect(downloader.downloadedUrls).toHaveLength(1);
  });

  test("extracts the helper from the release archive's parent directory", async () => {
    const archive = new AdmZip();
    archive.addFile(
      `${SCREEN_CAPTURE_HELPER_CACHE_FILENAME}/${SCREEN_CAPTURE_HELPER_CACHE_FILENAME}`,
      Buffer.from("signed-universal-helper"),
    );
    downloader.payload = archive.toBuffer();

    const helperPath = await makeProvider().ensure();
    expect(await fs.readFile(helperPath!, "utf8")).toBe("signed-universal-helper");
  });

  test("rejects a checksum mismatch without leaving an executable behind", async () => {
    checksumCalculator.checksum = "b".repeat(64);

    await expect(makeProvider().ensure()).rejects.toThrow(/checksum verification failed/);
    await expect(
      fs.access(path.join(cacheDir, SCREEN_CAPTURE_HELPER_CACHE_FILENAME)),
    ).rejects.toThrow();
  });

  test("rejects an archive without the helper executable", async () => {
    const archive = new AdmZip();
    archive.addFile("unexpected", Buffer.from("not a helper"));
    downloader.payload = archive.toBuffer();

    await expect(makeProvider().ensure()).rejects.toThrow(
      /must contain exactly one screen-capture-helper/,
    );
  });

  test("does not download an unverifiable release asset", async () => {
    const helperPath = await makeProvider("").ensure();

    expect(helperPath).toBeNull();
    expect(downloader.downloadedUrls).toEqual([]);
  });

  test("cancels a stalled release download at the helper-resolution deadline", async () => {
    let downloadStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      downloadStarted = resolve;
    });
    const stalled = new ScreenCaptureHelperProvider({
      cacheDir,
      checksumCalculator,
      timer,
      expectedChecksum: EXPECTED_SHA,
      downloadTimeoutMs: 1,
      releaseUrl: "https://releases.example/helper.zip",
      downloader: {
        download: (_url, _destination, signal) =>
          new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            downloadStarted?.();
          }),
      },
    });

    const ensuring = stalled.ensure();
    await started;
    timer.advanceTime(1);

    await expect(ensuring).rejects.toThrow(/Timed out downloading screen-capture-helper after 1ms/);
  });
});
