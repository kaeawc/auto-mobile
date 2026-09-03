import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import type { BootedDevice } from "../../src/models";
import { NetworkState } from "../../src/server/NetworkState";
import {
  isIosNetworkErrorSimulationAvailable,
  registerNetworkTools,
} from "../../src/server/networkTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { serverConfig } from "../../src/utils/ServerConfig";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

function ipaBytes(): Buffer {
  // A real CtrlProxy .ipa is a zip over 10KB; the override guard validates
  // magic + size (#4221 review), so fixtures cannot be one byte.
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(11_000)]);
}

function parseToolJson(response: any): any {
  return JSON.parse(response.content[0].text);
}

describe("network tool schema", () => {
  let iosMessages: string[];
  let androidMessages: string[];
  let iosErrorSimulations: unknown[];
  let iosGetInstanceSpy: ReturnType<typeof spyOn>;
  let androidGetInstanceSpy: ReturnType<typeof spyOn>;
  let originalIosBundlePath: string | undefined;
  let originalIosIpaPath: string | undefined;
  let originalSkipDownload: string | undefined;

  const iosDevice: BootedDevice = {
    deviceId: "ios-sim-1",
    name: "iPhone 15",
    platform: "ios",
  };

  const androidDevice: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Pixel",
    platform: "android",
  };

  beforeEach(() => {
    ToolRegistry.clearTools();
    NetworkState.resetInstance();
    originalIosBundlePath = process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH;
    originalIosIpaPath = process.env.AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH;
    originalSkipDownload = process.env.AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD;
    delete process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH;
    delete process.env.AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH;
    delete process.env.AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD;
    serverConfig.setEmbeddedSdkEnabled(true);
    serverConfig.setNetworkMockableEnabled(true);
    iosMessages = [];
    iosErrorSimulations = [];
    androidMessages = [];
    iosGetInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      sendMessage: (message: string) => {
        iosMessages.push(message);
        return true;
      },
      setNetworkErrorSimulation: async (config: unknown) => {
        iosErrorSimulations.push(config);
        return { success: true, totalTimeMs: 0 };
      },
    } as IOSCtrlProxyClient);
    androidGetInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      sendMessage: (message: string) => {
        androidMessages.push(message);
        return true;
      },
    } as AndroidCtrlProxyClient);
    registerNetworkTools();
  });

  afterEach(async () => {
    ToolRegistry.clearTools();
    NetworkState.resetInstance();
    serverConfig.setEmbeddedSdkEnabled(false);
    serverConfig.setNetworkMockableEnabled(false);
    iosGetInstanceSpy.mockRestore();
    androidGetInstanceSpy.mockRestore();
    if (localRunnerIpa) {
      await fs
        .rm(path.dirname(localRunnerIpa), { recursive: true, force: true })
        .catch(() => undefined);
      localRunnerIpa = undefined;
    }
    restoreEnv("AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH", originalIosBundlePath);
    restoreEnv("AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH", originalIosIpaPath);
    restoreEnv("AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD", originalSkipDownload);
  });

  function restoreEnv(key: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  }

  let localRunnerIpa: string | undefined;

  // Point the override at a REAL .ipa file. hasIosCtrlProxyRunnerOverride now
  // validates that the override resolves to a file (#4221), so a bare
  // non-existent path no longer counts as an available local runner.
  async function allowLocalIosRunner(): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nettools-local-runner-"));
    localRunnerIpa = path.join(dir, "CtrlProxyUITests-Runner.ipa");
    await fs.writeFile(localRunnerIpa, ipaBytes());
    process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH = localRunnerIpa;
  }

  test("requires durationSeconds when starting error simulation", () => {
    const tool = ToolRegistry.getTool("network");
    const result = tool!.schema.safeParse({
      simulateErrors: {
        errorType: "timeout",
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["simulateErrors", "durationSeconds"]);
      expect(result.error.issues[0].message).toBe(
        "durationSeconds is required unless cancel is true",
      );
    }
  });

  test("allows durationSeconds to be omitted when canceling error simulation", () => {
    const tool = ToolRegistry.getTool("network");
    const result = tool!.schema.safeParse({
      simulateErrors: {
        cancel: true,
      },
    });

    expect(result.success).toBe(true);
  });

  test("network simulateErrors syncs iOS error simulation through IOSCtrlProxyClient", async () => {
    await allowLocalIosRunner();
    const tool = ToolRegistry.getTool("network");

    const response = await tool!.deviceAwareHandler!(iosDevice, {
      simulateErrors: {
        errorType: "timeout",
        durationSeconds: 30,
        limit: 2,
      },
    });

    expect(parseToolJson(response).simulatingErrors).toEqual({
      errorType: "timeout",
      remainingSeconds: 30,
      limit: 2,
    });
    expect(iosGetInstanceSpy).toHaveBeenCalledWith(iosDevice);
    expect(androidGetInstanceSpy).not.toHaveBeenCalled();
    expect(iosMessages).toHaveLength(0);
    expect(iosErrorSimulations).toEqual([
      {
        enabled: true,
        errorType: "timeout",
        limit: 2,
        expiresAtEpochMs: expect.any(Number),
      },
    ]);
  });

  test("network simulateErrors rounds fractional iOS expiry before syncing", async () => {
    await allowLocalIosRunner();
    const state = NetworkState.getInstance();
    const nowSpy = spyOn(state.timer, "now").mockReturnValue(1_000);
    const tool = ToolRegistry.getTool("network");

    try {
      const response = await tool!.deviceAwareHandler!(iosDevice, {
        simulateErrors: {
          errorType: "timeout",
          durationSeconds: 1.2345,
        },
      });

      expect(parseToolJson(response).simulatingErrors).toEqual({
        errorType: "timeout",
        remainingSeconds: 2,
        limit: undefined,
      });
      expect(iosErrorSimulations).toEqual([
        {
          enabled: true,
          errorType: "timeout",
          limit: null,
          expiresAtEpochMs: 2_235,
        },
      ]);
      expect(state.simulation?.expiresAt).toBe(2_235);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("network simulateErrors on iOS reuses device expiry for local state", async () => {
    await allowLocalIosRunner();
    let nowMs = 1_000;
    const state = NetworkState.getInstance();
    const nowSpy = spyOn(state.timer, "now").mockImplementation(() => nowMs);
    iosGetInstanceSpy.mockRestore();
    iosGetInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      setNetworkErrorSimulation: async (config: unknown) => {
        iosErrorSimulations.push(config);
        nowMs += 5_000;
        return { success: true, totalTimeMs: 0 };
      },
    } as IOSCtrlProxyClient);
    const tool = ToolRegistry.getTool("network");

    try {
      await tool!.deviceAwareHandler!(iosDevice, {
        simulateErrors: {
          errorType: "timeout",
          durationSeconds: 30,
        },
      });

      const sent = iosErrorSimulations[0] as { expiresAtEpochMs: number };
      expect(sent.expiresAtEpochMs).toBe(31_000);
      expect(state.simulation?.expiresAt).toBe(sent.expiresAtEpochMs);
      expect(state.getSnapshot().simulatingErrors?.remainingSeconds).toBe(25);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("network simulateErrors cancel clears iOS error simulation on device", async () => {
    await allowLocalIosRunner();
    const tool = ToolRegistry.getTool("network");

    await tool!.deviceAwareHandler!(iosDevice, {
      simulateErrors: {
        errorType: "http500",
        durationSeconds: 30,
      },
    });
    iosMessages = [];

    const response = await tool!.deviceAwareHandler!(iosDevice, {
      simulateErrors: {
        cancel: true,
      },
    });

    expect(parseToolJson(response).simulatingErrors).toBeUndefined();
    expect(iosMessages).toHaveLength(0);
    expect(iosErrorSimulations.at(-1)).toEqual({
      enabled: false,
      errorType: null,
      limit: null,
      expiresAtEpochMs: null,
    });
  });

  test("network simulateErrors cancel clears local iOS state when device sync fails", async () => {
    await allowLocalIosRunner();
    const tool = ToolRegistry.getTool("network");

    await tool!.deviceAwareHandler!(iosDevice, {
      simulateErrors: {
        errorType: "http500",
        durationSeconds: 30,
      },
    });
    expect(NetworkState.getInstance().getSnapshot().simulatingErrors).toEqual({
      errorType: "http500",
      remainingSeconds: 30,
      limit: undefined,
    });
    iosGetInstanceSpy.mockRestore();
    iosGetInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      setNetworkErrorSimulation: async () => ({
        success: false,
        totalTimeMs: 0,
        error: "in-app server is unreachable",
      }),
    } as IOSCtrlProxyClient);

    await expect(
      tool!.deviceAwareHandler!(iosDevice, {
        simulateErrors: {
          cancel: true,
        },
      }),
    ).rejects.toThrow("in-app server is unreachable");

    expect(NetworkState.getInstance().getSnapshot().simulatingErrors).toBeUndefined();
  });

  test("network simulateErrors on iOS fails closed when CtrlProxy rejects the command", async () => {
    await allowLocalIosRunner();
    iosGetInstanceSpy.mockRestore();
    iosGetInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      setNetworkErrorSimulation: async () => ({
        success: false,
        totalTimeMs: 0,
        error: "iOS CtrlProxy runner does not support set_network_error_simulation",
      }),
    } as IOSCtrlProxyClient);
    const tool = ToolRegistry.getTool("network");

    await expect(
      tool!.deviceAwareHandler!(iosDevice, {
        simulateErrors: {
          errorType: "timeout",
          durationSeconds: 30,
        },
      }),
    ).rejects.toThrow("does not support set_network_error_simulation");

    expect(NetworkState.getInstance().getSnapshot().simulatingErrors).toBeUndefined();
  });

  test("network simulateErrors on iOS uses the bundled runner once a supporting release is pinned", async () => {
    const tool = ToolRegistry.getTool("network");

    const response = await tool!.deviceAwareHandler!(iosDevice, {
      simulateErrors: {
        errorType: "timeout",
        durationSeconds: 30,
      },
    });

    expect(parseToolJson(response).simulatingErrors).toEqual({
      errorType: "timeout",
      remainingSeconds: 30,
      limit: undefined,
    });
    expect(iosGetInstanceSpy).toHaveBeenCalledWith(iosDevice);
    expect(iosErrorSimulations).toEqual([
      {
        enabled: true,
        errorType: "timeout",
        limit: null,
        expiresAtEpochMs: expect.any(Number),
      },
    ]);
  });

  test("network simulateErrors cancel syncs bundled iOS runner once the supporting release is pinned", async () => {
    const state = NetworkState.getInstance();
    state.startSimulation("timeout", 30, null);
    const tool = ToolRegistry.getTool("network");

    const response = await tool!.deviceAwareHandler!(iosDevice, {
      simulateErrors: {
        cancel: true,
      },
    });

    expect(parseToolJson(response).simulatingErrors).toBeUndefined();
    expect(iosGetInstanceSpy).toHaveBeenCalledWith(iosDevice);
    expect(iosErrorSimulations).toEqual([
      {
        enabled: false,
        errorType: null,
        limit: null,
        expiresAtEpochMs: null,
      },
    ]);
    expect(state.getSnapshot().simulatingErrors).toBeUndefined();
  });

  test("network simulateErrors on iOS remains available when CtrlProxy downloads are skipped after a supporting release ships", async () => {
    process.env.AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD = "1";
    const tool = ToolRegistry.getTool("network");

    const response = await tool!.deviceAwareHandler!(iosDevice, {
      simulateErrors: {
        errorType: "timeout",
        durationSeconds: 30,
      },
    });

    expect(parseToolJson(response).simulatingErrors).toEqual({
      errorType: "timeout",
      remainingSeconds: 30,
      limit: undefined,
    });
    expect(iosGetInstanceSpy).toHaveBeenCalledWith(iosDevice);
    expect(iosErrorSimulations).toEqual([
      {
        enabled: true,
        errorType: "timeout",
        limit: null,
        expiresAtEpochMs: expect.any(Number),
      },
    ]);
  });

  test("iOS network error simulation release gate opens for a supporting released runner", () => {
    expect(
      isIosNetworkErrorSimulationAvailable({}, [
        {
          version: "0.0.41",
          apkSha256: "apk",
          ipaSha256: "ipa",
          runnerSha256: "runner",
        },
      ]),
    ).toBe(true);
  });

  test("an unusable override does not open the gate when the released runner is too old (#4221)", () => {
    // Below-min registry forces the version gate closed, so only a usable
    // override could open it. A directory or missing path must not.
    const oldRegistry = [{ version: "0.0.40", apkSha256: "a", ipaSha256: "i", runnerSha256: "r" }];

    expect(
      isIosNetworkErrorSimulationAvailable(
        {
          AUTOMOBILE_VERSION: "0.0.40",
          AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH: "/no/such/runner.ipa",
        },
        oldRegistry,
      ),
    ).toBe(false);
  });

  test("a usable .ipa override opens the gate even when the released runner is too old (#4221)", async () => {
    const overrideDir = await fs.mkdtemp(path.join(os.tmpdir(), "nettools-override-"));
    const ipa = path.join(overrideDir, "runner.ipa");
    await fs.writeFile(ipa, ipaBytes());
    try {
      const oldRegistry = [
        { version: "0.0.40", apkSha256: "a", ipaSha256: "i", runnerSha256: "r" },
      ];
      expect(
        isIosNetworkErrorSimulationAvailable(
          { AUTOMOBILE_VERSION: "0.0.40", AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH: ipa },
          oldRegistry,
        ),
      ).toBe(true);
    } finally {
      await fs.rm(overrideDir, { recursive: true, force: true });
    }
  });

  test("network simulateErrors still syncs Android through AndroidCtrlProxyClient", async () => {
    const tool = ToolRegistry.getTool("network");

    await tool!.deviceAwareHandler!(androidDevice, {
      simulateErrors: {
        errorType: "dnsFailure",
        durationSeconds: 15,
      },
    });

    expect(androidGetInstanceSpy).toHaveBeenCalledWith(androidDevice);
    expect(iosGetInstanceSpy).not.toHaveBeenCalled();
    expect(androidMessages).toHaveLength(1);
    expect(JSON.parse(androidMessages[0])).toMatchObject({
      type: "set_network_error_simulation",
      enabled: true,
      errorType: "dnsFailure",
      limit: null,
    });
  });

  test("mockNetwork creates an iOS rule and syncs through IOSCtrlProxyClient", async () => {
    const tool = ToolRegistry.getTool("mockNetwork");

    const response = await tool!.deviceAwareHandler!(iosDevice, {
      host: "api\\.example\\.com",
      path: "^/v1/items",
      method: "GET",
      limit: 2,
      statusCode: 500,
      responseHeaders: { "x-test": "yes" },
      responseBody: '{"error":"mocked"}',
      contentType: "application/json",
    });

    expect(parseToolJson(response)).toEqual({
      mockId: "mock-1",
      mocked: {
        "GET api\\.example\\.com^/v1/items": 2,
      },
    });
    expect(iosGetInstanceSpy).toHaveBeenCalledWith(iosDevice);
    expect(androidGetInstanceSpy).not.toHaveBeenCalled();
    expect(iosMessages).toHaveLength(1);
    expect(JSON.parse(iosMessages[0])).toEqual({
      type: "set_network_mock_rules",
      rules: [
        {
          mockId: "mock-1",
          host: "api\\.example\\.com",
          path: "^/v1/items",
          method: "GET",
          limit: 2,
          remaining: 2,
          statusCode: 500,
          responseHeaders: { "x-test": "yes" },
          responseBody: '{"error":"mocked"}',
          contentType: "application/json",
        },
      ],
    });
  });

  test("mockNetwork keeps the network-mockable gate for iOS", async () => {
    serverConfig.setNetworkMockableEnabled(false);
    const tool = ToolRegistry.getTool("mockNetwork");

    await expect(
      tool!.deviceAwareHandler!(iosDevice, {
        host: ".*",
        path: ".*",
      }),
    ).rejects.toThrow(
      "Network mocking is disabled. Start the server with --network-mockable to enable.",
    );
    expect(iosMessages).toHaveLength(0);
  });

  test("mockNetwork still syncs Android rules through AndroidCtrlProxyClient", async () => {
    const tool = ToolRegistry.getTool("mockNetwork");

    await tool!.deviceAwareHandler!(androidDevice, {
      host: "api\\.example\\.com",
      path: "/ok",
    });

    expect(androidGetInstanceSpy).toHaveBeenCalledWith(androidDevice);
    expect(iosGetInstanceSpy).not.toHaveBeenCalled();
    expect(androidMessages).toHaveLength(1);
    expect(JSON.parse(androidMessages[0]).type).toBe("set_network_mock_rules");
  });

  test("mockNetwork rejects invalid response header values before changing state", async () => {
    const tool = ToolRegistry.getTool("mockNetwork");

    await Promise.all(
      [{ "X-Invalid": "line\nbreak" }, { "X-Invalid": "café" }].map(async (responseHeaders) => {
        await expect(
          tool!.deviceAwareHandler!(androidDevice, {
            host: "api\\.example\\.com",
            path: "/users",
            responseHeaders,
          }),
        ).rejects.toThrow("Invalid mock response header");
      }),
    );

    expect(NetworkState.getInstance().getMockSummary()).toEqual({});
    expect(androidMessages).toHaveLength(0);
  });

  test("clearMockNetwork supports iOS and re-syncs remaining rules", async () => {
    const mockTool = ToolRegistry.getTool("mockNetwork");
    const clearTool = ToolRegistry.getTool("clearMockNetwork");

    await mockTool!.deviceAwareHandler!(iosDevice, {
      host: "api\\.example\\.com",
      path: "/one",
    });
    await mockTool!.deviceAwareHandler!(iosDevice, {
      host: "api\\.example\\.com",
      path: "/two",
      method: "POST",
    });
    iosMessages = [];

    const response = await clearTool!.deviceAwareHandler!(iosDevice, {
      mockId: "mock-1",
    });

    expect(parseToolJson(response)).toEqual({
      cleared: 1,
      remaining: {
        "POST api\\.example\\.com/two": -1,
      },
    });
    expect(iosMessages).toHaveLength(1);
    expect(JSON.parse(iosMessages[0]).rules.map((rule: { mockId: string }) => rule.mockId)).toEqual(
      ["mock-2"],
    );
  });
});
