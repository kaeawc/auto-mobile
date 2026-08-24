import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { sendSocketRequest } from "./helpers/socketRequest";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyManager } from "../../src/utils/CtrlProxyManager";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import type { BootedDevice } from "../../src/models";
import { RELEASE_CHECKSUM_REGISTRY, IOS_CTRL_PROXY_APP_HASH } from "../../src/constants/release";

const SHA256_HEX = /^[0-9a-f]{64}$/;

function createFakeDaemonState() {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({ getSession: () => null, releaseSession: async () => null }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
    }),
  };
}

function sendRequest(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<DaemonResponse> {
  return sendSocketRequest(socketPath, method, params);
}

describe("UnixSocketServer ide/status and ide/updateService handlers", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let fakeTimer: FakeTimer;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `t-ids-${randomUUID().slice(0, 8)}.sock`);
    fakeTimer = new FakeTimer();

    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
      null,
    );
    await server.start();
  });

  afterEach(async () => {
    await server.close();
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
  });

  test("ide/status returns a usable, self-consistent update artifact", async () => {
    const response = await sendRequest(socketPath, "ide/status");

    expect(response.success).toBe(true);
    const result = response.result as {
      version: string;
      releaseVersion: string;
      android: { ctrlProxy: { expectedSha256: string; url: string } };
      ios: { xcTestService: { expectedSha256: string; expectedAppHash: string; url: string } };
    };
    const entry = RELEASE_CHECKSUM_REGISTRY[0];

    expect(result.version.length).toBeGreaterThan(0);
    // No env override in this test, so the daemon resolves to the newest pinned
    // release — not the floating "latest" tag (#2746).
    expect(result.releaseVersion).toBe(entry.version);

    // Android artifact must be actually fetchable + verifiable: the checksum is a
    // real 64-hex digest equal to the registry's, and the URL points at this
    // version's apk. An empty-string url/sha (the prior weakness) fails both.
    expect(result.android.ctrlProxy.expectedSha256).toMatch(SHA256_HEX);
    expect(result.android.ctrlProxy.expectedSha256).toBe(entry.apkSha256);
    expect(result.android.ctrlProxy.url).toContain(`/${entry.version}/`);
    expect(result.android.ctrlProxy.url.endsWith("control-proxy-debug.apk")).toBe(true);

    // iOS xctest service, same contract. expectedAppHash is deliberately the empty
    // "skip verification" sentinel (IOS_CTRL_PROXY_APP_HASH), so pin it to that
    // constant rather than a 64-hex shape.
    expect(result.ios.xcTestService.expectedSha256).toMatch(SHA256_HEX);
    expect(result.ios.xcTestService.expectedSha256).toBe(entry.ipaSha256);
    expect(result.ios.xcTestService.url).toContain(`/${entry.version}/`);
    expect(result.ios.xcTestService.url.endsWith("control-proxy.ipa")).toBe(true);
    expect(result.ios.xcTestService.expectedAppHash).toBe(IOS_CTRL_PROXY_APP_HASH);
  });

  test("ide/status reports a concrete releaseVersion, never the 'latest' literal (EC7)", async () => {
    const response = await sendRequest(socketPath, "ide/status");
    const result = response.result as {
      releaseVersion: string;
      android: { ctrlProxy: { url: string } };
    };
    // Issue #2746: external consumers must see the concrete version the daemon
    // will actually fetch, not the floating "latest" tag.
    expect(result.releaseVersion).not.toBe("latest");
    expect(result.releaseVersion).toBe(RELEASE_CHECKSUM_REGISTRY[0].version);
    expect(result.android.ctrlProxy.url).toContain(`/${RELEASE_CHECKSUM_REGISTRY[0].version}/`);
  });

  test("ide/status honors AUTOMOBILE_VERSION + AUTOMOBILE_ASSET_BASE_URL (EC7)", async () => {
    const prevVersion = process.env.AUTOMOBILE_VERSION;
    const prevBase = process.env.AUTOMOBILE_ASSET_BASE_URL;
    process.env.AUTOMOBILE_VERSION = "0.0.18";
    process.env.AUTOMOBILE_ASSET_BASE_URL = "https://mirror.test/am";
    try {
      const response = await sendRequest(socketPath, "ide/status");
      const result = response.result as {
        releaseVersion: string;
        android: { ctrlProxy: { expectedSha256: string; url: string } };
        ios: { xcTestService: { expectedSha256: string; url: string } };
      };
      expect(result.releaseVersion).toBe("0.0.18");
      expect(result.android.ctrlProxy.url).toBe(
        "https://mirror.test/am/0.0.18/control-proxy-debug.apk",
      );
      expect(result.android.ctrlProxy.expectedSha256).toBe(
        "fd3c8d9f0b8542eaad56c78b18cf8e5666367b04ae8c4af74d8aa6dd1c8d1834",
      );
      expect(result.ios.xcTestService.url).toBe("https://mirror.test/am/0.0.18/control-proxy.ipa");
      expect(result.ios.xcTestService.expectedSha256).toBe(
        "2a5eec63bce2f9dfc227c0732fcce67378305e945604d5eedd0e3df48e37fd39",
      );
    } finally {
      if (prevVersion === undefined) {
        delete process.env.AUTOMOBILE_VERSION;
      } else {
        process.env.AUTOMOBILE_VERSION = prevVersion;
      }
      if (prevBase === undefined) {
        delete process.env.AUTOMOBILE_ASSET_BASE_URL;
      } else {
        process.env.AUTOMOBILE_ASSET_BASE_URL = prevBase;
      }
    }
  });

  test("ide/updateService returns error for missing params", async () => {
    const response = await sendRequest(socketPath, "ide/updateService", {});

    expect(response.success).toBe(false);
    expect(response.error).toContain("requires");
  });

  test("ide/updateService returns error for missing deviceId", async () => {
    const response = await sendRequest(socketPath, "ide/updateService", { platform: "android" });

    expect(response.success).toBe(false);
    expect(response.error).toContain("requires");
  });

  test("ide/updateService returns error for invalid platform", async () => {
    const response = await sendRequest(socketPath, "ide/updateService", {
      deviceId: "emulator-5554",
      platform: "windows",
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("Invalid platform");
  });

  test("ide/updateService does not report skipped Android update as success", async () => {
    const device: BootedDevice = {
      deviceId: "emulator-5554",
      platform: "android",
      isEmulator: true,
      name: "Pixel",
    };
    const platformSpy = spyOn(PlatformDeviceManagerFactory, "getInstance").mockReturnValue({
      getBootedDevices: async () => [device],
    } as any);
    const ctrlProxySpy = spyOn(AndroidCtrlProxyManager, "getInstance").mockReturnValue({
      ensureCompatibleVersion: async () => ({
        status: "skipped",
        expectedSha256: "",
        acceptedPreinstalled: true,
      }),
    } as any);

    try {
      const response = await sendRequest(socketPath, "ide/updateService", {
        deviceId: "emulator-5554",
        platform: "android",
      });

      expect(response.success).toBe(true);
      const result = response.result as {
        success: boolean;
        message: string;
        status: { status: string };
      };
      expect(result.success).toBe(false);
      expect(result.message).toContain("Accessibility service skipped");
      expect(result.status.status).toBe("skipped");
    } finally {
      ctrlProxySpy.mockRestore();
      platformSpy.mockRestore();
    }
  });
});
