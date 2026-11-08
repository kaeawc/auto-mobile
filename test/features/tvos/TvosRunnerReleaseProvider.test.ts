import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  TvosRunnerReleaseProvider,
  TVOS_RUNNER_METADATA_FILENAME,
  type TvosRunnerReleaseProviderDeps,
} from "../../../src/features/tvos/TvosRunnerReleaseProvider";
import { FakeChecksumCalculator } from "../../fakes/FakeChecksumCalculator";
import { FakeFileDownloader } from "../../fakes/FakeFileDownloader";
import { FakeTimer } from "../../fakes/FakeTimer";

const SHA = "a".repeat(64);
const URL = "https://releases.example/tvos-runner-macos.zip";
const RUN = "AutoMobileTVTest_appletvsimulator26.5-arm64.xctestrun";
let root: string;
let cacheDir: string;
let sequence = 0;
let downloader: FakeFileDownloader;
let checksumCalculator: FakeChecksumCalculator;
let timer: FakeTimer;
let extracts: string[][];

function reset() {
  cacheDir = path.join(root, `case-${sequence++}`);
  downloader = new FakeFileDownloader();
  checksumCalculator = new FakeChecksumCalculator();
  checksumCalculator.checksum = SHA;
  timer = new FakeTimer();
  extracts = [];
}

function provider(deps: TvosRunnerReleaseProviderDeps = {}) {
  return new TvosRunnerReleaseProvider({
    cacheDir,
    downloader,
    checksumCalculator,
    timer,
    platform: "darwin",
    expectedChecksum: SHA,
    releaseUrl: URL,
    env: { AUTOMOBILE_VERSION: "1.0.0" },
    extract: async (zip, dest) => {
      extracts.push([zip, dest]);
      const products = path.join(dest, "Build", "Products");
      await fs.mkdir(products, { recursive: true });
      await fs.writeFile(path.join(products, RUN), "runner");
      await fs.writeFile(path.join(products, `automobile-runner-${RUN}`), "launch copy");
      await fs.writeFile(path.join(products, "AutoMobileTest_iphonesimulator.xctestrun"), "ios");
    },
    ...deps,
  });
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "tvos-release-provider-"));
  reset();
  await provider().ensure();
});
beforeEach(reset);
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("verifies before extracting, discovers only the tvOS template and caches across instances", async () => {
  const expected = path.join(cacheDir, SHA, "Build", "Products", RUN);
  expect(await provider().ensure()).toBe(expected);
  expect(downloader.downloadedUrls).toEqual([URL]);
  expect(checksumCalculator.computedFiles).toEqual(downloader.downloadedDestinations);
  expect(extracts).toHaveLength(1);
  expect(extracts[0][0]).toBe(downloader.downloadedDestinations[0]);
  expect(extracts[0][1]).toContain(".staging-");
  expect(await fs.readdir(cacheDir)).toEqual([SHA]);
  expect(
    JSON.parse(await fs.readFile(path.join(cacheDir, SHA, TVOS_RUNNER_METADATA_FILENAME), "utf8")),
  ).toMatchObject({ version: "1.0.0", sha256: SHA, downloadedAt: timer.now() });
  expect(await provider().ensure()).toBe(expected);
  expect(downloader.downloadedUrls).toEqual([URL]);
  expect(timer.getSleepHistory()).toEqual([]);
  if (process.platform !== "win32") {
    expect((await fs.stat(cacheDir)).mode & 0o777).toBe(0o700);
    expect(
      (await fs.stat(path.join(cacheDir, SHA, TVOS_RUNNER_METADATA_FILENAME))).mode & 0o777,
    ).toBe(0o600);
  }
});

test("checksum mismatch never extracts or publishes products", async () => {
  checksumCalculator.checksum = "b".repeat(64);
  await expect(provider().ensure()).rejects.toThrow("checksum verification failed");
  expect(extracts).toEqual([]);
  expect(await fs.readdir(cacheDir)).toEqual([]);
});

test("empty checksum fails closed before any download or filesystem discovery", async () => {
  expect(
    await provider({
      expectedChecksum: "",
      fileSystem: {
        readdir: async () => {
          throw new Error("must not inspect files");
        },
        stat: async () => {
          throw new Error("must not inspect files");
        },
      },
    }).ensure(),
  ).toBeNull();
  expect(downloader.downloadedUrls).toEqual([]);
});

test.each(["linux", "win32"] as const)("%s never downloads a tvOS runner", async (platform) => {
  expect(await provider({ platform }).ensure()).toBeNull();
  expect(downloader.downloadedUrls).toEqual([]);
});

test("coalesces concurrent ensure calls", async () => {
  const instance = provider();
  const [first, second] = await Promise.all([instance.ensure(), instance.ensure()]);
  expect(first).toBe(second);
  expect(downloader.downloadedUrls).toEqual([URL]);
  expect(extracts).toHaveLength(1);
});

test("missing cached xctestrun causes a fresh verified extraction", async () => {
  const first = await provider().ensure();
  expect(first).not.toBeNull();
  await fs.rm(first!);
  expect(await provider().ensure()).toBe(first);
  expect(downloader.downloadedUrls).toEqual([URL, URL]);
});

test("a stale sidecar checksum cannot authorize cached products", async () => {
  await provider().ensure();
  await fs.writeFile(
    path.join(cacheDir, SHA, TVOS_RUNNER_METADATA_FILENAME),
    JSON.stringify({ sha256: "b".repeat(64) }),
  );
  await provider().ensure();
  expect(downloader.downloadedUrls).toEqual([URL, URL]);
});

test("ignores launch copies using injected filesystem discovery", async () => {
  await expect(
    provider({
      fileSystem: {
        readdir: async () => [`automobile-runner-${RUN}`],
        stat: async () => ({ isFile: () => true }),
      },
    }).ensure(),
  ).rejects.toThrow("exactly one appletvsimulator xctestrun");
  expect(await fs.readdir(cacheDir)).toEqual([]);
});

test("rejects ambiguous tvOS templates rather than selecting an arbitrary runner", async () => {
  await expect(
    provider({
      fileSystem: {
        readdir: async () => [RUN, `Other_${RUN}`],
        stat: async () => ({ isFile: () => true }),
      },
    }).ensure(),
  ).rejects.toThrow("exactly one appletvsimulator xctestrun");
  expect(await fs.readdir(cacheDir)).toEqual([]);
});

test("extraction failure cleans staging without publishing a cache entry", async () => {
  await expect(
    provider({
      extract: async () => {
        throw new Error("invalid archive");
      },
    }).ensure(),
  ).rejects.toThrow("Unable to resolve the released tvOS runner: invalid archive");
  expect(await fs.readdir(cacheDir)).toEqual([]);
});

test("a cancelled waiter does not cancel another caller's shared download", async () => {
  const instance = provider();
  const controller = new AbortController();
  const cancelled = instance.ensure(controller.signal);
  const remaining = instance.ensure();
  controller.abort(new Error("cancelled"));
  await expect(cancelled).rejects.toThrow("cancelled");
  expect(await remaining).toContain(RUN);
  expect(downloader.downloadedUrls).toEqual([URL]);
});
