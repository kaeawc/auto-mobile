import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SimulatorRunnerReleaseProviderDeps } from "../../../src/features/shared/SimulatorRunnerReleaseProvider";
import { VisionosRunnerArtifacts } from "../../../src/features/visionos/VisionosRunnerArtifacts";
import {
  VisionosRunnerReleaseProvider,
  VISIONOS_RUNNER_METADATA_FILENAME,
} from "../../../src/features/visionos/VisionosRunnerReleaseProvider";
import { WatchRunnerArtifacts } from "../../../src/features/watch/WatchRunnerArtifacts";
import {
  WatchRunnerReleaseProvider,
  WATCHOS_RUNNER_METADATA_FILENAME,
} from "../../../src/features/watch/WatchRunnerReleaseProvider";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeChecksumCalculator } from "../../fakes/FakeChecksumCalculator";
import { FakeFileDownloader } from "../../fakes/FakeFileDownloader";
import { FakeTimer } from "../../fakes/FakeTimer";

type Release = { ensure(signal?: AbortSignal): Promise<string | null> };

interface PlatformCase {
  name: string;
  run: string;
  metadata: string;
  url: string;
  create(deps: SimulatorRunnerReleaseProviderDeps): Release;
  artifacts(deps: {
    release: Release;
    built: () => string | null;
    onBuild: (args: string[]) => void;
    override?: string;
    local?: string;
  }): { resolve(): Promise<string> };
}

function builder(built: () => string | null, local?: string) {
  return {
    getConfig: () => ({ projectRoot: "/repo", derivedDataPath: "/derived" }),
    getXctestrunPath: async () => local ?? built(),
  };
}

const CASES: PlatformCase[] = [
  {
    name: "watchOS",
    run: "CtrlProxyWatch_watchsimulator26.5-arm64.xctestrun",
    metadata: WATCHOS_RUNNER_METADATA_FILENAME,
    url: "https://releases.example/watchos-runner-macos.zip",
    create: (deps) => new WatchRunnerReleaseProvider(deps),
    artifacts: ({ release, built, onBuild, override, local }) =>
      new WatchRunnerArtifacts({
        builder: builder(built, local),
        release,
        override: () => override,
        access: async () => {},
        projectLocator: { launchDirectory: () => "/repo", packageRoot: () => "/package" },
        xcodebuild: {
          executeCommand: async (args) => {
            onBuild(args);
            return createExecResult("BUILD SUCCEEDED", "");
          },
        },
      }),
  },
  {
    name: "visionOS",
    run: "AutoMobileVisionTest_xrsimulator26.5-arm64.xctestrun",
    metadata: VISIONOS_RUNNER_METADATA_FILENAME,
    url: "https://releases.example/visionos-runner-macos.zip",
    create: (deps) => new VisionosRunnerReleaseProvider(deps),
    artifacts: ({ release, built, onBuild, override, local }) =>
      new VisionosRunnerArtifacts({
        builder: builder(built, local),
        release,
        override: () => override,
        access: async () => {},
        xcodebuild: {
          executeCommand: async (args) => {
            onBuild(args);
            return createExecResult("BUILD SUCCEEDED", "");
          },
        },
      }),
  },
];

const SHA = "a".repeat(64);
let root: string;
let sequence = 0;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-release-providers-"));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe.each(CASES)("$name runner release", (platform) => {
  let cacheDir: string;
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

  function provider(deps: SimulatorRunnerReleaseProviderDeps = {}) {
    return platform.create({
      cacheDir,
      downloader,
      checksumCalculator,
      timer,
      platform: "darwin",
      expectedChecksum: SHA,
      releaseUrl: platform.url,
      env: { AUTOMOBILE_VERSION: "1.0.0" },
      extract: async (zip, dest) => {
        extracts.push([zip, dest]);
        const products = path.join(dest, "Build", "Products");
        await fs.mkdir(products, { recursive: true });
        await fs.writeFile(path.join(products, platform.run), "runner");
        await fs.writeFile(path.join(products, `automobile-runner-${platform.run}`), "copy");
        await fs.writeFile(path.join(products, "AutoMobileTVTest_appletvsimulator.xctestrun"), "");
        await fs.writeFile(path.join(products, "AutoMobileTest_iphonesimulator.xctestrun"), "");
      },
      ...deps,
    });
  }

  function resolver(release: Release, opts: { override?: string; local?: string } = {}) {
    const builds: string[][] = [];
    let built: string | null = null;
    const artifacts = platform.artifacts({
      release,
      built: () => built,
      onBuild: (args) => {
        builds.push(args);
        built = `/derived/Build/Products/${platform.run}`;
      },
      ...opts,
    });
    return { artifacts, builds };
  }

  beforeAll(async () => {
    reset();
    await provider().ensure();
  });
  beforeEach(reset);

  test("verifies before extracting, discovers only its own template and caches it", async () => {
    const expected = path.join(cacheDir, SHA, "Build", "Products", platform.run);
    expect(await provider().ensure()).toBe(expected);
    expect(downloader.downloadedUrls).toEqual([platform.url]);
    expect(checksumCalculator.computedFiles).toEqual(downloader.downloadedDestinations);
    expect(extracts).toHaveLength(1);
    expect(
      JSON.parse(await fs.readFile(path.join(cacheDir, SHA, platform.metadata), "utf8")),
    ).toMatchObject({ version: "1.0.0", sha256: SHA });
    expect(await provider().ensure()).toBe(expected);
    expect(downloader.downloadedUrls).toEqual([platform.url]);
  });

  test("checksum mismatch fails closed and never falls through to a local build", async () => {
    checksumCalculator.checksum = "b".repeat(64);
    const { artifacts, builds } = resolver(provider());
    await expect(artifacts.resolve()).rejects.toThrow(
      `${platform.name} runner checksum verification failed`,
    );
    expect(builds).toEqual([]);
    expect(extracts).toEqual([]);
    expect(await fs.readdir(cacheDir)).toEqual([]);
  });

  test("an empty pin or a non-macOS host never downloads", async () => {
    expect(await provider({ expectedChecksum: "" }).ensure()).toBeNull();
    expect(await provider({ platform: "linux" }).ensure()).toBeNull();
    expect(downloader.downloadedUrls).toEqual([]);
  });

  test("a download failure falls through to the local source build", async () => {
    downloader.shouldThrow = new Error("Download failed: HTTP 404 Not Found");
    const { artifacts, builds } = resolver(provider());
    expect(await artifacts.resolve()).toBe(`/derived/Build/Products/${platform.run}`);
    expect(builds).toHaveLength(1);
    expect(extracts).toEqual([]);
  });

  test("the xctestrun override and existing local products take precedence over the download", async () => {
    const override = path.resolve("/prebuilt", platform.run);
    expect(await resolver(provider(), { override }).artifacts.resolve()).toBe(override);
    const local = `/derived/Build/Products/${platform.run}`;
    const { artifacts, builds } = resolver(provider(), { local });
    expect(await artifacts.resolve()).toBe(local);
    expect(builds).toEqual([]);
    expect(downloader.downloadedUrls).toEqual([]);
  });

  test("the released runner is used instead of building from source", async () => {
    const { artifacts, builds } = resolver(provider());
    expect(await artifacts.resolve()).toBe(
      path.join(cacheDir, SHA, "Build", "Products", platform.run),
    );
    expect(builds).toEqual([]);
  });
});
