import { describe, expect, test } from "bun:test";
import type { BootedDevice, OpenURLResult } from "../../src/models";
import { ActionableError } from "../../src/models";
import {
  APPLE_PLATFORM_SUPPORTED_TOOLS,
  assertToolSupportsDevicePlatform,
} from "../../src/server/applePlatformToolSupport";
import { withTvosOpenLink } from "../../src/server/tvosOpenLink";
import { toolJson } from "../helpers/toolResponse";

const tv: BootedDevice = {
  name: "Apple TV 4K (3rd generation)",
  deviceId: "5B7E1C3D-2A4F-4E6B-8C9D-1E2F3A4B5C6D",
  platform: "tvos",
};

function fakeOpener(result: (url: string) => OpenURLResult) {
  const urls: string[] = [];
  return {
    urls,
    factory: () => ({
      execute: async (url: string) => {
        urls.push(url);
        return result(url);
      },
    }),
  };
}

const mobileCalls: string[] = [];
const mobileHandler = async (device: BootedDevice) => {
  mobileCalls.push(device.platform);
  return { content: [] };
};

describe("openLink and getDeepLinks on an Apple TV (#16724)", () => {
  test("both tools are on the tvOS allowlist", () => {
    expect(APPLE_PLATFORM_SUPPORTED_TOOLS.tvos.has("openLink")).toBe(true);
    expect(APPLE_PLATFORM_SUPPORTED_TOOLS.tvos.has("getDeepLinks")).toBe(true);
    expect(() => assertToolSupportsDevicePlatform("openLink", tv)).not.toThrow();
    expect(() => assertToolSupportsDevicePlatform("getDeepLinks", tv)).not.toThrow();
  });

  test("openLink opens the URL through the injected opener and reports it", async () => {
    const opener = fakeOpener((url) => ({ success: true, url }));
    const handler = withTvosOpenLink(mobileHandler, { openUrlFactory: opener.factory });

    const response = await handler(tv, { url: "television://show/42" });

    expect(opener.urls).toEqual(["television://show/42"]);
    expect(toolJson(response)).toMatchObject({
      message: "Opened link television://show/42",
      success: true,
      url: "television://show/42",
    });
    expect((response as { isError?: boolean }).isError).toBeUndefined();
  });

  test("a failed open marks the response as an error", async () => {
    const opener = fakeOpener((url) => ({ success: false, url, error: "no handler" }));
    const handler = withTvosOpenLink(mobileHandler, { openUrlFactory: opener.factory });

    const response = await handler(tv, { url: "nobody://x" });

    expect((response as { isError?: boolean }).isError).toBe(true);
    expect(toolJson(response).message).toBe("Failed to open nobody://x: no handler");
  });

  test("openLink refuses waitFor on tvOS before opening anything", async () => {
    const opener = fakeOpener((url) => ({ success: true, url }));
    const handler = withTvosOpenLink(mobileHandler, { openUrlFactory: opener.factory });

    await expect(
      handler(tv, { url: "television://x", waitFor: { text: "Episode" } } as Parameters<
        typeof handler
      >[1]),
    ).rejects.toThrow(ActionableError);
    expect(opener.urls).toEqual([]);
  });

  test("Android and iOS devices keep the existing openLink handler", async () => {
    const opener = fakeOpener((url) => ({ success: true, url }));
    const handler = withTvosOpenLink(mobileHandler, { openUrlFactory: opener.factory });
    mobileCalls.length = 0;

    await handler({ ...tv, platform: "ios" }, { url: "myapp://x" });
    await handler({ ...tv, platform: "android" }, { url: "myapp://x" });

    expect(mobileCalls).toEqual(["ios", "android"]);
    expect(opener.urls).toEqual([]);
  });
});
