import { describe, expect, spyOn, test } from "bun:test";
import { audioLoopbackHelperPath } from "../../../src/features/audio/audioLoopbackHelper";
import { ActionableError } from "../../../src/models/ActionableError";
import { logger } from "../../../src/utils/logger";

class FakeHelperProvider {
  calls = 0;
  path: string | null = "/cache/audio-loopback-helper";
  failure?: Error;
  async ensure(): Promise<string | null> {
    this.calls++;
    if (this.failure) {
      throw this.failure;
    }
    return this.path;
  }
}

describe("audioLoopbackHelperPath", () => {
  test("the existing env override wins without calling the provider", async () => {
    const provider = new FakeHelperProvider();
    const existing: string[] = [];
    expect(
      await audioLoopbackHelperPath(
        { AUTOMOBILE_IOS_AUDIO_LOOPBACK_HELPER: "/local/helper" },
        {
          provider,
          platform: "darwin",
          exists: (path) => {
            existing.push(path);
            return true;
          },
        },
      ),
    ).toBe("/local/helper");
    expect(existing).toEqual(["/local/helper"]);
    expect(provider.calls).toBe(0);
  });

  test.each(["/missing/helper", ""])(
    "an invalid explicit override %s never falls back to a download",
    async (override) => {
      const provider = new FakeHelperProvider();
      expect(
        await audioLoopbackHelperPath(
          { AUTOMOBILE_IOS_AUDIO_LOOPBACK_HELPER: override },
          {
            provider,
            platform: "darwin",
            exists: () => false,
          },
        ),
      ).toBeUndefined();
      expect(provider.calls).toBe(0);
    },
  );

  test("unset env uses the provider on macOS", async () => {
    const provider = new FakeHelperProvider();
    expect(await audioLoopbackHelperPath({}, { provider, platform: "darwin" })).toBe(
      provider.path ?? undefined,
    );
    expect(provider.calls).toBe(1);
  });

  test("non-macOS does not call the provider", async () => {
    const provider = new FakeHelperProvider();
    expect(await audioLoopbackHelperPath({}, { provider, platform: "linux" })).toBeUndefined();
    expect(provider.calls).toBe(0);
  });

  test("null provider result preserves the unavailable-helper behavior", async () => {
    const provider = new FakeHelperProvider();
    provider.path = null;
    expect(await audioLoopbackHelperPath({}, { provider, platform: "darwin" })).toBeUndefined();
  });

  test("failed resolution logs and returns undefined", async () => {
    const provider = new FakeHelperProvider();
    provider.failure = new ActionableError("checksum mismatch");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await audioLoopbackHelperPath({}, { provider, platform: "darwin" })).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "Unable to resolve the released audio-loopback helper",
        provider.failure,
      );
    } finally {
      warn.mockRestore();
    }
  });
});
