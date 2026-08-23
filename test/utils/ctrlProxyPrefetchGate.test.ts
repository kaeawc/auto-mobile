import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AndroidCtrlProxyManager } from "../../src/utils/CtrlProxyManager";
import type { AndroidPrerequisiteDetector } from "../../src/utils/android-cmdline-tools/AndroidPrerequisiteDetector";
import { FakeFileDownloader } from "../fakes/FakeFileDownloader";

/**
 * Gate for the startup APK prefetch: it must skip cleanly when Android
 * prerequisites are absent and still download when they are present (#4404).
 */
describe("AndroidCtrlProxyManager prefetch prerequisite gate", function () {
  let fakeDownloader: FakeFileDownloader;
  let originalApkPathEnv: string | undefined;

  const detectorReturning = (value: boolean): AndroidPrerequisiteDetector => ({
    hasAndroidPrerequisites: async () => value,
  });

  beforeEach(async function () {
    originalApkPathEnv = process.env.AUTOMOBILE_CTRL_PROXY_APK_PATH;
    // The local-APK override short-circuits prefetch entirely; keep it unset.
    delete process.env.AUTOMOBILE_CTRL_PROXY_APK_PATH;
    await AndroidCtrlProxyManager.cleanupPrefetchedApk();
    fakeDownloader = new FakeFileDownloader();
    AndroidCtrlProxyManager.setPrefetchFileDownloaderForTesting(fakeDownloader);
  });

  afterEach(async function () {
    AndroidCtrlProxyManager.setAndroidPrerequisiteDetectorForTesting(null);
    AndroidCtrlProxyManager.setPrefetchFileDownloaderForTesting(null);
    await AndroidCtrlProxyManager.cleanupPrefetchedApk();
    if (originalApkPathEnv === undefined) {
      delete process.env.AUTOMOBILE_CTRL_PROXY_APK_PATH;
    } else {
      process.env.AUTOMOBILE_CTRL_PROXY_APK_PATH = originalApkPathEnv;
    }
  });

  test("does not download the APK when Android prerequisites are absent", async function () {
    AndroidCtrlProxyManager.setAndroidPrerequisiteDetectorForTesting(detectorReturning(false));

    AndroidCtrlProxyManager.prefetchApk();
    // Draining the prefetch promise must resolve null without throwing, so the
    // daemon stays healthy and non-Android workflows are unaffected.
    const result = await AndroidCtrlProxyManager.getPrefetchedApkPath();

    expect(result).toBeNull();
    expect(fakeDownloader.downloadedUrls).toHaveLength(0);
  });

  test("attempts the APK download when Android prerequisites are present", async function () {
    AndroidCtrlProxyManager.setAndroidPrerequisiteDetectorForTesting(detectorReturning(true));

    AndroidCtrlProxyManager.prefetchApk();
    await AndroidCtrlProxyManager.getPrefetchedApkPath();

    // The gate let the prefetch through, so the download was attempted.
    expect(fakeDownloader.downloadedUrls).toHaveLength(1);
  });
});
