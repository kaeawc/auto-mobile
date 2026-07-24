import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  ensureIosScreenCaptureHelper,
  IOS_SCREEN_CAPTURE_HELPER_ENV,
  IOS_SCREEN_CAPTURE_HELPER_SKIP_DOWNLOAD_ENV,
  type ScreenCaptureHelperEnsurer,
} from "../../../src/features/webrtc/IosH264Source";

/** A fake download provider that records calls and returns a fixed result. */
class FakeHelperProvider implements ScreenCaptureHelperEnsurer {
  public calls = 0;
  constructor(private readonly result: string | null) {}
  public async ensure(): Promise<string | null> {
    this.calls += 1;
    return this.result;
  }
}

describe("ensureIosScreenCaptureHelper precedence (#4392)", function() {
  const moduleDir = path.join(path.resolve("repo"), "src", "features", "webrtc");
  const localBuild = path.join(
    path.resolve("repo"),
    "ios",
    "screen-capture",
    ".build",
    "debug",
    "screen-capture-helper"
  );

  test("uses the env override and never consults the download provider", async function() {
    const provider = new FakeHelperProvider("/downloaded/helper");
    const found = await ensureIosScreenCaptureHelper({
      moduleDir,
      env: { [IOS_SCREEN_CAPTURE_HELPER_ENV]: "/custom/helper" },
      exists: candidate => candidate === "/custom/helper",
      provider,
    });

    expect(found).toBe("/custom/helper");
    expect(provider.calls).toBe(0);
  });

  test("uses a local Swift .build output without downloading", async function() {
    const provider = new FakeHelperProvider("/downloaded/helper");
    const found = await ensureIosScreenCaptureHelper({
      moduleDir,
      env: {},
      exists: candidate => candidate === localBuild,
      provider,
    });

    expect(found).toBe(localBuild);
    expect(provider.calls).toBe(0);
  });

  test("falls back to the verified download when no local helper exists", async function() {
    const provider = new FakeHelperProvider("/downloaded/helper");
    const found = await ensureIosScreenCaptureHelper({
      moduleDir,
      env: {},
      exists: () => false,
      provider,
    });

    expect(found).toBe("/downloaded/helper");
    expect(provider.calls).toBe(1);
  });

  test("throws and never downloads when the skip-download flag is set", async function() {
    const provider = new FakeHelperProvider("/downloaded/helper");
    await expect(
      ensureIosScreenCaptureHelper({
        moduleDir,
        env: { [IOS_SCREEN_CAPTURE_HELPER_SKIP_DOWNLOAD_ENV]: "1" },
        exists: () => false,
        provider,
      })
    ).rejects.toThrow(/requires a screen-capture-helper/);
    expect(provider.calls).toBe(0);
  });

  test("throws when no local helper exists and the download degrades to null", async function() {
    const provider = new FakeHelperProvider(null);
    await expect(
      ensureIosScreenCaptureHelper({
        moduleDir,
        env: {},
        exists: () => false,
        provider,
      })
    ).rejects.toThrow(/requires a screen-capture-helper/);
    expect(provider.calls).toBe(1);
  });
});
