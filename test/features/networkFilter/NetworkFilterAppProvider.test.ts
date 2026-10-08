import { describe, expect, test } from "bun:test";
import path from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  NETWORK_FILTER_METADATA_FILENAME,
  NETWORK_FILTER_OVERRIDE_VERSION,
  NetworkFilterAppProvider,
} from "../../../src/features/networkFilter/NetworkFilterAppProvider";
import {
  NETWORK_FILTER_APP_NAME,
  NETWORK_FILTER_APP_PATH_ENV,
} from "../../../src/features/networkFilter/networkFilterApp";
import type { FileDownloader } from "../../../src/utils/FileDownloader";
import { FakeChecksumCalculator } from "../../fakes/FakeChecksumCalculator";
import {
  FakeNetworkFilterCommandRunner,
  FakeNetworkFilterFileSystem,
} from "../../fakes/FakeNetworkFilterHost";
import { FakeTimer } from "../../fakes/FakeTimer";

const CACHE = path.join(path.sep, "cache", "network-filter");
const EXPECTED_SHA = "b".repeat(64);
const RELEASE_URL = "https://releases.example/automobile-network-filter-macos-universal.zip";

class RecordingDownloader implements FileDownloader {
  readonly urls: string[] = [];
  constructor(private readonly fileSystem: FakeNetworkFilterFileSystem) {}

  async download(url: string, destination: string): Promise<void> {
    this.urls.push(url);
    this.fileSystem.addFile(destination, "zip");
  }
}

function setup(options: { checksum?: string; env?: NodeJS.ProcessEnv; expected?: string } = {}) {
  const fileSystem = new FakeNetworkFilterFileSystem();
  const runner = new FakeNetworkFilterCommandRunner();
  runner.handler = (file, args) => {
    if (file === "ditto" && args[0] === "-x") {
      fileSystem.addApp(path.join(String(args[3]), NETWORK_FILTER_APP_NAME));
    }
    return {};
  };
  const downloader = new RecordingDownloader(fileSystem);
  const checksumCalculator = new FakeChecksumCalculator();
  checksumCalculator.checksum = options.checksum ?? EXPECTED_SHA;
  const timer = new FakeTimer();
  const provider = new NetworkFilterAppProvider({
    downloader,
    checksumCalculator,
    fileSystem,
    commandRunner: runner,
    cacheDir: CACHE,
    timer,
    env: options.env ?? { AUTOMOBILE_VERSION: "0.0.90" },
    expectedChecksum: "expected" in options ? options.expected : EXPECTED_SHA,
    releaseUrl: RELEASE_URL,
  });
  return { provider, fileSystem, runner, downloader, timer };
}

describe("NetworkFilterAppProvider", () => {
  test("downloads, verifies, unpacks with ditto and records metadata", async () => {
    const { provider, fileSystem, runner, downloader } = setup();

    const candidate = await provider.ensure();

    expect(candidate).toEqual({
      appPath: path.join(CACHE, "app", NETWORK_FILTER_APP_NAME),
      source: "release",
      version: "0.0.90",
      sha256: EXPECTED_SHA,
    });
    expect(downloader.urls).toEqual([RELEASE_URL]);
    expect(runner.commandsFor("ditto")[0]?.args.slice(0, 2)).toEqual(["-x", "-k"]);
    const metadata = JSON.parse(
      (await fileSystem.readText(path.join(CACHE, NETWORK_FILTER_METADATA_FILENAME))) ?? "{}",
    );
    expect(metadata).toMatchObject({ version: "0.0.90", sha256: EXPECTED_SHA });
    expect([...fileSystem.files.keys()].some((file) => file.endsWith(".download"))).toBe(false);
  });

  test("reuses a cached app whose metadata matches the expected checksum", async () => {
    const { provider, downloader } = setup();
    await provider.ensure();
    await provider.ensure();
    expect(downloader.urls).toHaveLength(1);
  });

  test("checksum mismatch fails closed without unpacking", async () => {
    const { provider, runner, fileSystem } = setup({ checksum: "c".repeat(64) });

    const error = await provider.ensure().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("checksum verification failed");
    expect(runner.calls).toHaveLength(0);
    expect(fileSystem.files.size).toBe(0);
  });

  test("a version without a published asset fails closed instead of downloading", async () => {
    const { provider, downloader } = setup({
      env: { AUTOMOBILE_VERSION: "0.0.17" },
      expected: undefined,
    });

    const error = await provider.ensure().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("No Network Extension app is published for AutoMobile 0.0.17");
    expect(downloader.urls).toHaveLength(0);
  });

  test("an archive without the app is rejected", async () => {
    const { provider, runner } = setup();
    runner.handler = () => ({});

    await expect(provider.ensure()).rejects.toThrow("does not contain");
  });

  test("times out a stalled download with an actionable error", async () => {
    const { fileSystem, timer } = setup();
    const stalled: FileDownloader = {
      download: (_url, _destination, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const provider = new NetworkFilterAppProvider({
      downloader: stalled,
      checksumCalculator: new FakeChecksumCalculator(),
      fileSystem,
      commandRunner: new FakeNetworkFilterCommandRunner(),
      cacheDir: CACHE,
      timer,
      env: {},
      expectedChecksum: EXPECTED_SHA,
      releaseUrl: RELEASE_URL,
      downloadTimeoutMs: 1_000,
    });

    const pending = provider.ensure().catch((caught: unknown) => caught);
    for (let turn = 0; turn < 50 && timer.getPendingTimeoutCount() === 0; turn++) {
      await Promise.resolve();
    }
    timer.advanceTime(1_000);

    expect(String(await pending)).toContain("Timed out downloading the Network Extension app");
  });

  test("an override pointing at a built .app is used without downloading", async () => {
    const appPath = path.join(path.sep, "work", "build", NETWORK_FILTER_APP_NAME);
    const { provider, fileSystem, downloader } = setup({
      env: { [NETWORK_FILTER_APP_PATH_ENV]: appPath },
    });
    fileSystem.addApp(appPath);

    expect(await provider.ensure()).toEqual({
      appPath,
      source: "override",
      version: NETWORK_FILTER_OVERRIDE_VERSION,
      sha256: null,
    });
    expect(downloader.urls).toHaveLength(0);
  });

  test("an override that is not a real .app fails closed", async () => {
    const notApp = path.join(path.sep, "work", "build");
    const { provider, fileSystem } = setup({ env: { [NETWORK_FILTER_APP_PATH_ENV]: notApp } });
    fileSystem.addFile(path.join(notApp, "file"), "x");
    await expect(provider.ensure()).rejects.toThrow("ending in .app");

    const emptyApp = path.join(path.sep, "work", "Empty.app");
    const second = setup({ env: { [NETWORK_FILTER_APP_PATH_ENV]: emptyApp } });
    await second.fileSystem.ensureDir(emptyApp);
    await expect(second.provider.ensure()).rejects.toThrow("network-filter-controller");
  });
});
