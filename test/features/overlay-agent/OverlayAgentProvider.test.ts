import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  IOS_OVERLAY_AGENT_ENV,
  OVERLAY_AGENT_CACHE_FILENAME,
  OVERLAY_AGENT_METADATA_FILENAME,
  OverlayAgentProvider,
  SKIP_IOS_OVERLAY_AGENT_DOWNLOAD_ENV,
  type OverlayAgentProviderDeps,
} from "../../../src/features/overlay-agent/OverlayAgentProvider";
import { logger } from "../../../src/utils/logger";
import { createFileBackedDbHarness, type FileBackedDbHarness } from "../../db/withFileBackedDb";
import { FakeChecksumCalculator } from "../../fakes/FakeChecksumCalculator";
import { FakeFileDownloader } from "../../fakes/FakeFileDownloader";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";

const EXPECTED_SHA = "b".repeat(64);
const DYLIB = Buffer.from("fake dylib bytes; never loaded");
const RELEASE_URL = "https://releases.example/AutoMobileOverlayAgent.dylib";

describe("OverlayAgentProvider", () => {
  let tempDirs: FileBackedDbHarness;
  let rootDir: string;
  let cacheDir: string;
  let downloader: FakeFileDownloader;
  let checksumCalculator: FakeChecksumCalculator;
  let timer: FakeTimer;
  let next = 0;

  function makeProvider(overrides: OverlayAgentProviderDeps = {}): OverlayAgentProvider {
    return new OverlayAgentProvider({
      cacheDir,
      downloader,
      checksumCalculator,
      timer,
      idGenerator: new FakeIdGenerator(),
      expectedChecksum: EXPECTED_SHA,
      releaseUrl: RELEASE_URL,
      env: { AUTOMOBILE_VERSION: "0.0.82" },
      ...overrides,
    });
  }

  beforeAll(async () => {
    tempDirs = createFileBackedDbHarness({ env: {} });
    rootDir = await tempDirs.makeTempDbDir("overlay-agent-unit-");
  });

  beforeEach(async () => {
    cacheDir = path.join(rootDir, `test-${next++}`);
    await fs.mkdir(cacheDir);
    downloader = new FakeFileDownloader();
    downloader.payload = DYLIB;
    checksumCalculator = new FakeChecksumCalculator();
    checksumCalculator.checksum = EXPECTED_SHA;
    timer = new FakeTimer();
  });

  afterAll(async () => {
    await tempDirs.cleanup();
  });

  const dylibPath = () => path.join(cacheDir, OVERLAY_AGENT_CACHE_FILENAME);
  const metadataPath = () => path.join(cacheDir, OVERLAY_AGENT_METADATA_FILENAME);
  const exists = (p: string) =>
    fs.access(p).then(
      () => true,
      () => false,
    );

  test("downloads, verifies, caches with metadata, then hits the cache", async () => {
    const provider = makeProvider();
    const first = await provider.ensure();
    expect(first).toEqual({ path: dylibPath(), source: "download" });
    expect(downloader.downloadedUrls).toEqual([RELEASE_URL]);
    expect(JSON.parse(await fs.readFile(metadataPath(), "utf8"))).toMatchObject({
      version: "0.0.82",
      sha256: EXPECTED_SHA,
      size: DYLIB.length,
    });
    if (process.platform !== "win32") {
      expect((await fs.stat(dylibPath())).mode & 0o777).toBe(0o600);
    }

    const second = await provider.ensure();
    expect(second).toEqual({ path: dylibPath(), source: "cache" });
    expect(downloader.downloadedUrls).toHaveLength(1);
  });

  test("cache hit with matching metadata re-hashes the dylib and does not download", async () => {
    await fs.writeFile(dylibPath(), DYLIB);
    await fs.writeFile(
      metadataPath(),
      JSON.stringify({ sha256: EXPECTED_SHA.toUpperCase(), size: DYLIB.length }),
    );
    expect(await makeProvider().ensure()).toEqual({ path: dylibPath(), source: "cache" });
    expect(downloader.downloadedUrls).toEqual([]);
    expect(checksumCalculator.computedFiles).toEqual([dylibPath()]);
  });

  test("same-size corruption behind a matching sidecar is not a cache hit", async () => {
    await fs.writeFile(dylibPath(), DYLIB);
    await fs.writeFile(
      metadataPath(),
      JSON.stringify({ sha256: EXPECTED_SHA, size: DYLIB.length }),
    );
    checksumCalculator.checksum = "c".repeat(64);
    const env = { AUTOMOBILE_VERSION: "0.0.82", [SKIP_IOS_OVERLAY_AGENT_DOWNLOAD_ENV]: "1" };
    await expect(makeProvider({ env }).ensure()).rejects.toThrow(/download is disabled/);
  });

  test("checksum mismatch refuses and deletes everything it wrote", async () => {
    checksumCalculator.checksum = "c".repeat(64);
    await expect(makeProvider().ensure()).rejects.toThrow(/checksum verification failed/);
    expect(await fs.readdir(cacheDir)).toEqual([]);
  });

  test("a failed attempt leaves a published cache entry it did not install", async () => {
    await fs.writeFile(dylibPath(), DYLIB);
    await fs.writeFile(metadataPath(), JSON.stringify({ sha256: "stale", size: 1 }));
    checksumCalculator.checksum = "c".repeat(64);
    await expect(makeProvider().ensure()).rejects.toThrow(/checksum verification failed/);
    expect(await exists(dylibPath())).toBe(true);
    expect(await exists(metadataPath())).toBe(true);
    // readdir order is filesystem-defined (ext4 hash order differs from APFS/NTFS); sort first.
    expect((await fs.readdir(cacheDir)).sort()).toEqual([
      OVERLAY_AGENT_CACHE_FILENAME,
      OVERLAY_AGENT_METADATA_FILENAME,
    ]);
  });

  test("missing checksum degrades with an actionable error and never downloads", async () => {
    const provider = makeProvider({ expectedChecksum: "", env: { AUTOMOBILE_VERSION: "0.0.1" } });
    await expect(provider.ensure()).rejects.toThrow(/unavailable for this build/);
    expect(downloader.downloadedUrls).toEqual([]);
  });

  test("skip-download env uses a verified cache but refuses to download", async () => {
    const env = { AUTOMOBILE_VERSION: "0.0.82", [SKIP_IOS_OVERLAY_AGENT_DOWNLOAD_ENV]: "1" };
    await expect(makeProvider({ env }).ensure()).rejects.toThrow(/download is disabled/);
    expect(downloader.downloadedUrls).toEqual([]);

    await fs.writeFile(dylibPath(), DYLIB);
    await fs.writeFile(
      metadataPath(),
      JSON.stringify({ sha256: EXPECTED_SHA, size: DYLIB.length }),
    );
    expect((await makeProvider({ env }).ensure()).source).toBe("cache");
  });

  test("explicit path wins over env, env wins over local build and download", async () => {
    const explicit = path.join(cacheDir, "explicit.dylib");
    const fromEnv = path.join(cacheDir, "env.dylib");
    const local = path.join(cacheDir, "local.dylib");
    await Promise.all([explicit, fromEnv, local].map((p) => fs.writeFile(p, DYLIB)));
    const env = { [IOS_OVERLAY_AGENT_ENV]: fromEnv };
    const provider = makeProvider({ env, localBuildPaths: [local] });

    expect(await provider.ensure(explicit)).toEqual({ path: explicit, source: "explicit" });
    expect(await provider.ensure()).toEqual({ path: fromEnv, source: "env" });
    expect(await makeProvider({ localBuildPaths: [local] }).ensure()).toEqual({
      path: local,
      source: "local-build",
    });
    expect(downloader.downloadedUrls).toEqual([]);
    expect(checksumCalculator.computedFiles).toEqual([]);
  });

  test("relative env and local-build paths resolve against the daemon launch directory", async () => {
    await fs.writeFile(path.join(cacheDir, "env.dylib"), DYLIB);
    await fs.writeFile(path.join(cacheDir, "local.dylib"), DYLIB);
    const env = { AUTOMOBILE_DAEMON_LAUNCH_CWD: cacheDir };
    expect(
      await makeProvider({ env: { ...env, [IOS_OVERLAY_AGENT_ENV]: "env.dylib" } }).ensure(),
    ).toEqual({ path: path.join(cacheDir, "env.dylib"), source: "env" });
    expect(await makeProvider({ env, localBuildPaths: ["local.dylib"] }).ensure()).toEqual({
      path: path.join(cacheDir, "local.dylib"),
      source: "local-build",
    });
  });

  test("a configured env override that is missing fails instead of falling back to download", async () => {
    const env = { [IOS_OVERLAY_AGENT_ENV]: path.join(cacheDir, "nope.dylib") };
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      await expect(makeProvider({ env }).ensure()).rejects.toThrow(IOS_OVERLAY_AGENT_ENV);
    } finally {
      debug.mockRestore();
    }
    expect(downloader.downloadedUrls).toEqual([]);
  });

  test.each([
    "{}",
    "null",
    '{"sha256":',
    JSON.stringify({ sha256: EXPECTED_SHA }),
    JSON.stringify({ sha256: EXPECTED_SHA, size: "32" }),
    JSON.stringify({ sha256: EXPECTED_SHA, size: DYLIB.length + 5 }),
  ])("repairs unusable cache metadata %s by downloading", async (metadata) => {
    await fs.writeFile(dylibPath(), DYLIB);
    await fs.writeFile(metadataPath(), metadata);
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      expect(await makeProvider().ensure()).toEqual({ path: dylibPath(), source: "download" });
      expect(JSON.parse(await fs.readFile(metadataPath(), "utf8"))).toMatchObject({
        sha256: EXPECTED_SHA,
        size: DYLIB.length,
      });
    } finally {
      debug.mockRestore();
    }
  });

  test("concurrent callers share a single download", async () => {
    const provider = makeProvider();
    const results = await Promise.all([provider.ensure(), provider.ensure(), provider.ensure()]);
    expect(new Set(results.map((r) => r.path)).size).toBe(1);
    expect(downloader.downloadedUrls).toHaveLength(1);
    expect(checksumCalculator.computedFiles).toHaveLength(1);
  });

  test("a failed download clears single-flight so the next call retries", async () => {
    downloader.shouldThrow = new Error("network down");
    const provider = makeProvider();
    await expect(provider.ensure()).rejects.toThrow("network down");
    downloader.shouldThrow = null;
    expect((await provider.ensure()).source).toBe("download");
  });

  test("overlapping downloads use distinct partials and both end with one valid dylib", async () => {
    const a = makeProvider({ idGenerator: new FakeIdGenerator(["a1"]) });
    const b = makeProvider({ idGenerator: new FakeIdGenerator(["b1"]) });
    const results = await Promise.all([a.ensure(), b.ensure()]);
    expect(results.map((r) => r.path)).toEqual([dylibPath(), dylibPath()]);
    expect([...downloader.downloadedDestinations].sort()).toEqual([
      `${dylibPath()}.a1.download`,
      `${dylibPath()}.b1.download`,
    ]);
    expect((await fs.readdir(cacheDir)).sort()).toEqual([
      OVERLAY_AGENT_CACHE_FILENAME,
      OVERLAY_AGENT_METADATA_FILENAME,
    ]);
    expect(await fs.readFile(dylibPath())).toEqual(DYLIB);
  });

  test("a failed attempt removes only its own partial", async () => {
    const otherPartial = `${dylibPath()}.other.download`;
    await fs.writeFile(otherPartial, DYLIB);
    checksumCalculator.checksum = "c".repeat(64);
    await expect(
      makeProvider({ idGenerator: new FakeIdGenerator(["mine"]) }).ensure(),
    ).rejects.toThrow(/checksum verification failed/);
    expect(downloader.downloadedDestinations).toEqual([`${dylibPath()}.mine.download`]);
    expect(await fs.readdir(cacheDir)).toEqual([path.basename(otherPartial)]);
  });
});
