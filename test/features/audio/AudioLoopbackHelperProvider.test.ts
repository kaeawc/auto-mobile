import AdmZip from "adm-zip";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AUDIO_LOOPBACK_HELPER_CACHE_FILENAME,
  AUDIO_LOOPBACK_HELPER_METADATA_FILENAME,
  AudioLoopbackHelperProvider,
  type AudioLoopbackHelperProviderDeps,
} from "../../../src/features/audio/AudioLoopbackHelperProvider";
import { ActionableError } from "../../../src/models/ActionableError";
import { FakeChecksumCalculator } from "../../fakes/FakeChecksumCalculator";
import { FakeFileDownloader } from "../../fakes/FakeFileDownloader";
import { FakeTimer } from "../../fakes/FakeTimer";

const SHA = "a".repeat(64);
const URL = "https://releases.example/audio-loopback-helper.zip";
const CONTENT = Buffer.from("signed universal audio helper; never executed");

describe("AudioLoopbackHelperProvider", () => {
  let root: string;
  let cacheDir: string;
  let payload: Buffer;
  let downloader: FakeFileDownloader;
  let checksumCalculator: FakeChecksumCalculator;
  let timer: FakeTimer;
  let nextDir = 0;

  function provider(overrides: AudioLoopbackHelperProviderDeps = {}) {
    return new AudioLoopbackHelperProvider({
      cacheDir,
      downloader,
      checksumCalculator,
      timer,
      expectedChecksum: SHA,
      releaseUrl: URL,
      platform: "darwin",
      env: { AUTOMOBILE_VERSION: "0.0.88" },
      ...overrides,
    });
  }

  beforeAll(async () => {
    const zip = new AdmZip();
    zip.addFile(AUDIO_LOOPBACK_HELPER_CACHE_FILENAME, CONTENT);
    payload = zip.toBuffer();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "audio-loopback-provider-"));
    // Warm the zip/fs paths outside per-test timing, as in the screen helper tests.
    cacheDir = path.join(root, "warmup");
    downloader = new FakeFileDownloader();
    downloader.payload = payload;
    checksumCalculator = new FakeChecksumCalculator();
    checksumCalculator.checksum = SHA;
    timer = new FakeTimer();
    await provider().ensure();
  });

  beforeEach(() => {
    cacheDir = path.join(root, `case-${nextDir++}`);
    downloader = new FakeFileDownloader();
    downloader.payload = payload;
    checksumCalculator = new FakeChecksumCalculator();
    checksumCalculator.checksum = SHA;
    timer = new FakeTimer();
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("downloads, verifies and extracts the helper, then reuses the cache across instances", async () => {
    const helperPath = path.join(cacheDir, AUDIO_LOOPBACK_HELPER_CACHE_FILENAME);
    expect(await provider().ensure()).toBe(helperPath);
    expect(await fs.readFile(helperPath)).toEqual(CONTENT);
    expect(downloader.downloadedUrls).toEqual([URL]);
    expect(checksumCalculator.computedFiles).toEqual(downloader.downloadedDestinations);
    expect(
      JSON.parse(
        await fs.readFile(path.join(cacheDir, AUDIO_LOOPBACK_HELPER_METADATA_FILENAME), "utf8"),
      ),
    ).toMatchObject({
      version: "0.0.88",
      sha256: SHA,
      size: CONTENT.length,
      downloadedAt: timer.now(),
    });
    if (process.platform !== "win32") {
      expect((await fs.stat(cacheDir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(helperPath)).mode & 0o777).toBe(0o700);
      expect(
        (await fs.stat(path.join(cacheDir, AUDIO_LOOPBACK_HELPER_METADATA_FILENAME))).mode & 0o777,
      ).toBe(0o600);
    }
    expect(await provider().ensure()).toBe(helperPath);
    expect(downloader.downloadedUrls).toEqual([URL]);
  });

  test("coalesces concurrent resolution into one verified download", async () => {
    const instance = provider();
    const [first, second] = await Promise.all([instance.ensure(), instance.ensure()]);
    expect(first).toBe(second);
    expect(downloader.downloadedUrls).toEqual([URL]);
  });

  test("rejects a checksum mismatch with ActionableError and publishes no helper", async () => {
    checksumCalculator.checksum = "b".repeat(64);
    await expect(provider().ensure()).rejects.toBeInstanceOf(ActionableError);
    await expect(
      fs.access(path.join(cacheDir, AUDIO_LOOPBACK_HELPER_CACHE_FILENAME)),
    ).rejects.toThrow();
    expect(await fs.readdir(cacheDir)).toEqual([]);
  });

  test("an empty pin returns null without downloading", async () => {
    expect(await provider({ expectedChecksum: "" }).ensure()).toBeNull();
    expect(downloader.downloadedUrls).toEqual([]);
  });

  test.each(["linux", "win32"] as const)(
    "%s returns undefined without downloading",
    async (platform) => {
      expect(await provider({ platform }).ensure()).toBeUndefined();
      expect(downloader.downloadedUrls).toEqual([]);
    },
  );

  test("rejects archives without exactly one named helper", async () => {
    const zip = new AdmZip();
    zip.addFile("wrong-helper", CONTENT);
    downloader.payload = zip.toBuffer();
    await expect(provider().ensure()).rejects.toThrow(
      "must contain exactly one audio-loopback-helper",
    );
  });

  test("rejects duplicate named helpers", async () => {
    const zip = new AdmZip(payload);
    zip.addFile(`nested/${AUDIO_LOOPBACK_HELPER_CACHE_FILENAME}`, CONTENT);
    downloader.payload = zip.toBuffer();
    await expect(provider().ensure()).rejects.toThrow(
      "must contain exactly one audio-loopback-helper",
    );
  });

  test("wraps download errors in ActionableError", async () => {
    downloader.shouldThrow = new Error("offline");
    await expect(provider().ensure()).rejects.toThrow(
      "Unable to resolve the released audio-loopback helper: offline",
    );
  });
});
