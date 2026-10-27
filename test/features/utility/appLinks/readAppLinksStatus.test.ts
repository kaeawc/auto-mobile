import { describe, expect, spyOn, test } from "bun:test";
import { DeviceAppLinksStatusReader } from "../../../../src/features/utility/appLinks/readAppLinksStatus";
import { GetDeepLinks } from "../../../../src/features/utility/GetDeepLinks";
import type { DeepLinkResult } from "../../../../src/models";
import { logger } from "../../../../src/utils/logger";
import { FakeAppLinksDevice, fakeAppLinksTarget } from "../../../fakes/FakeAppLinksDevice";

const PKG = "com.example.shop";

const installed = () =>
  new FakeAppLinksDevice().install(PKG, {
    verification: { "shop.example.com": "verified" },
    otherDomains: ["promo.example.net"],
    users: { 10: { enabled: ["promo.example.net"] } },
  });

describe("DeviceAppLinksStatusReader (#14110)", () => {
  test("reports the current user's per-domain state", async () => {
    const reader = new DeviceAppLinksStatusReader(
      fakeAppLinksTarget(installed(), { currentUserId: 10 }),
    );
    expect(await reader.read(PKG)).toEqual({
      appLinks: [
        {
          domain: "shop.example.com",
          state: "verified",
          autoVerify: true,
          userSelected: false,
          approvedForLinks: true,
        },
        {
          domain: "promo.example.net",
          autoVerify: false,
          userSelected: true,
          approvedForLinks: true,
        },
      ],
      appLinksUserId: 10,
      appLinkHandlingAllowed: true,
    });
  });

  test("pre-Android 12 is flagged without reading pm", async () => {
    const appLinks = installed();
    const reader = new DeviceAppLinksStatusReader(fakeAppLinksTarget(appLinks, { apiLevel: 30 }));
    expect(await reader.read(PKG)).toEqual({
      appLinksUnavailable: expect.stringContaining("Android 12 (API 31)"),
    });
    expect(appLinks.calls).toEqual([]);
  });

  test("an app without web domains reports an empty list", async () => {
    const reader = new DeviceAppLinksStatusReader(fakeAppLinksTarget(new FakeAppLinksDevice()));
    expect(await reader.read(PKG)).toEqual({ appLinks: [], appLinksUserId: 0 });
  });

  test("a failed read is logged and reported, never thrown", async () => {
    const appLinks = installed();
    appLinks.failNext("read", new Error("adb: device offline"));
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const reader = new DeviceAppLinksStatusReader(fakeAppLinksTarget(appLinks));
      expect(await reader.read(PKG)).toEqual({
        appLinksUnavailable: "Failed to read App Links state: adb: device offline",
      });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("GetDeepLinks App Links section", () => {
  const declared: DeepLinkResult = {
    success: true,
    appId: PKG,
    deepLinks: { schemes: ["https"], hosts: [], intentFilters: [], supportedMimeTypes: [] },
  };

  test("merges the App Links state into a successful Android result", async () => {
    const reader = { read: async () => ({ appLinks: [], appLinksUserId: 0 }) };
    const result = await new GetDeepLinks(
      null,
      { getDeepLinks: async () => declared },
      reader,
    ).execute(PKG);
    expect(result).toEqual({ ...declared, appLinks: [], appLinksUserId: 0 });
  });

  test("a failed declared-link read skips App Links", async () => {
    let reads = 0;
    const reader = {
      read: async () => {
        reads += 1;
        return {};
      },
    };
    const failed = { ...declared, success: false, error: "not installed" };
    const result = await new GetDeepLinks(
      null,
      { getDeepLinks: async () => failed },
      reader,
    ).execute(PKG);
    expect(result).toEqual(failed);
    expect(reads).toBe(0);
  });
});
