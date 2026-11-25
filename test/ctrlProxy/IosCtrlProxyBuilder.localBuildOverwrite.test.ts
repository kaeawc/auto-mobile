import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import { useScratchRoot } from "../helpers/scratchRoot";
import { IosCtrlProxyBuilder } from "../../src/ctrlProxy/IosCtrlProxyBuilder";
import { extractIosCtrlProxyBundle } from "../../src/ctrlProxy/IosCtrlProxyBundleExtraction";
import { findLocalXcodeBuildEntry } from "../../src/ctrlProxy/IosLocalBuildDerivedData";
import { ActionableError } from "../../src/models/ActionableError";
import { FakeIOSCtrlProxyBundleDownloader } from "../fakes/FakeIOSCtrlProxyBundleDownloader";
import { FakeDirectoryLock } from "../fakes/FakeDirectoryLock";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeCtrlProxyCodesignVerifier } from "../fakes/FakeCtrlProxyCodesignVerifier";

// #19183: a release download must never delete or replace a local Xcode build in the
// configured derived-data directory, and daemons sharing that directory install one at a time.
describe("iOS release runner install over a configured derived-data directory", () => {
  const envKeys = [
    "AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD",
    "AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD",
    "AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH",
    "AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH",
  ];
  const scratch = useScratchRoot("ios-local-build-overwrite-");
  let savedEnv: (string | undefined)[];
  let originalPlatform: PropertyDescriptor | undefined;
  let derivedDataPath: string;
  let bundleCacheDir: string;
  let localXctestrun: string;
  let downloader: FakeIOSCtrlProxyBundleDownloader;
  let lock: FakeDirectoryLock;

  async function writeLocalXcodeBuild(): Promise<void> {
    await fs.mkdir(path.join(derivedDataPath, "Build", "Intermediates.noindex"), {
      recursive: true,
    });
    await fs.mkdir(path.join(derivedDataPath, "Build", "Products", "Debug-iphonesimulator"), {
      recursive: true,
    });
    await fs.writeFile(localXctestrun, "local xctestrun");
  }

  function builder(): IosCtrlProxyBuilder {
    return IosCtrlProxyBuilder.getInstance(
      { derivedDataPath, bundleCacheDir },
      { downloader, derivedDataProcessLock: lock },
    );
  }

  beforeEach(async () => {
    savedEnv = envKeys.map((key) => process.env[key]);
    for (const key of envKeys) {
      delete process.env[key];
    }
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    IosCtrlProxyBuilder.resetInstances();
    IosCtrlProxyBuilder.configure({
      useLocalBuild: false,
      expectedChecksum: "release-checksum",
      expectedRunnerChecksum: "",
      expectedRunnerChecksumTarget: null,
      timer: new FakeTimer(),
      codesignVerifier: new FakeCtrlProxyCodesignVerifier(),
      prerequisiteDetector: { hasIosPrerequisites: async () => true },
    });
    const root = scratch.next();
    derivedDataPath = path.join(root, "dd");
    bundleCacheDir = path.join(root, "cache");
    localXctestrun = path.join(
      derivedDataPath,
      "Build",
      "Products",
      "AutoMobileTest_iphonesimulator27.2-arm64.xctestrun",
    );
    downloader = new FakeIOSCtrlProxyBundleDownloader();
    downloader.checksum = "release-checksum";
    lock = new FakeDirectoryLock();
  });

  afterEach(() => {
    IosCtrlProxyBuilder.resetInstances();
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    for (const [index, key] of envKeys.entries()) {
      const value = savedEnv[index];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("build refuses before downloading and keeps the local runner", async () => {
    await writeLocalXcodeBuild();

    const result = await builder().build("simulator");

    expect(result.success).toBe(false);
    expect(result.error).toContain("AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD=true");
    expect(result.error).toContain(path.join(derivedDataPath, "Build", "Intermediates.noindex"));
    expect(downloader.downloadedUrls).toEqual([]);
    expect(downloader.extractedPaths).toEqual([]);
    expect(await fs.readFile(localXctestrun, "utf-8")).toBe("local xctestrun");
  });

  test("the startup prefetch leaves the local runner in place", async () => {
    await writeLocalXcodeBuild();
    IosCtrlProxyBuilder.configure({ prefetchBuilder: builder() });

    const result = await IosCtrlProxyBuilder.prefetchBuild();

    expect(result?.success).toBe(false);
    expect(downloader.extractedPaths).toEqual([]);
    expect(await fs.readFile(localXctestrun, "utf-8")).toBe("local xctestrun");
  });

  test("cleanBuildArtifacts keeps a local build", async () => {
    await writeLocalXcodeBuild();

    await builder().cleanBuildArtifacts();

    expect(await fs.readFile(localXctestrun, "utf-8")).toBe("local xctestrun");
  });

  test("extraction itself refuses a local build without emptying it", async () => {
    await writeLocalXcodeBuild();
    const verifier = builder()["artifactVerifier"];

    const extraction = extractIosCtrlProxyBundle(path.join(bundleCacheDir, "x.ipa"), null, {
      derivedDataPath,
      downloader,
      artifactVerifier: verifier,
      normalizeExtractedBundle: async () => {},
    });

    await expect(extraction).rejects.toBeInstanceOf(ActionableError);
    expect(downloader.extractedPaths).toEqual([]);
    expect(await fs.readFile(localXctestrun, "utf-8")).toBe("local xctestrun");
  });

  test("a release extraction still replaces an earlier release in the directory", async () => {
    await fs.mkdir(path.join(derivedDataPath, "Build", "Products"), { recursive: true });
    await fs.writeFile(localXctestrun, "earlier release");

    expect(await findLocalXcodeBuildEntry(derivedDataPath)).toBeNull();
    const result = await builder().build("simulator");

    expect(result.success).toBe(true);
    expect(downloader.extractedPaths).toEqual([derivedDataPath]);
    expect(lock.acquired).toEqual([path.dirname(derivedDataPath)]);
  });

  test("a release another daemon installed while this one waited is reused, not re-extracted", async () => {
    const subject = builder();
    const releaseXctestrun = path.join(
      derivedDataPath,
      "Build",
      "Products",
      "AutoMobileTest_iphonesimulator.xctestrun",
    );
    lock.onAcquire = async () => {
      await fs.mkdir(path.join(derivedDataPath, "Build", "Products", "Debug-iphonesimulator"), {
        recursive: true,
      });
      await fs.writeFile(releaseXctestrun, "other daemon's release");
      await fs.writeFile(
        subject["artifactVerifier"].getMetadataPath(),
        JSON.stringify({
          checksum: "release-checksum",
          version: "test",
          extractedAt: "2026-11-24T22:53:34.000Z",
          derivedDataPath,
        }),
      );
    };

    const result = await subject.build("simulator");

    expect(result.success).toBe(true);
    expect(result.xctestrunPath).toBe(releaseXctestrun);
    expect(downloader.extractedPaths).toEqual([]);
    expect(await fs.readFile(releaseXctestrun, "utf-8")).toBe("other daemon's release");
  });

  test("metadata from a different derived-data directory does not skip extraction", async () => {
    const subject = builder();
    lock.onAcquire = async () => {
      await fs.writeFile(
        subject["artifactVerifier"].getMetadataPath(),
        JSON.stringify({
          checksum: "release-checksum",
          version: "test",
          extractedAt: "2026-11-24T22:53:34.000Z",
          derivedDataPath: `${derivedDataPath}-other`,
        }),
      );
    };

    const result = await subject.build("simulator");

    expect(result.success).toBe(true);
    expect(downloader.extractedPaths).toEqual([derivedDataPath]);
  });
});
