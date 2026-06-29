import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import type { BootedDevice } from "../../src/models";
import { NetworkState } from "../../src/server/NetworkState";
import { registerNetworkTools } from "../../src/server/networkTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { serverConfig } from "../../src/utils/ServerConfig";

function parseToolJson(response: any): any {
  return JSON.parse(response.content[0].text);
}

describe("network tool schema", () => {
  let iosMessages: string[];
  let androidMessages: string[];
  let iosGetInstanceSpy: ReturnType<typeof spyOn>;
  let androidGetInstanceSpy: ReturnType<typeof spyOn>;

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
    serverConfig.setEmbeddedSdkEnabled(true);
    serverConfig.setNetworkMockableEnabled(true);
    iosMessages = [];
    androidMessages = [];
    iosGetInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      sendMessage: (message: string) => {
        iosMessages.push(message);
        return true;
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

  afterEach(() => {
    ToolRegistry.clearTools();
    NetworkState.resetInstance();
    serverConfig.setEmbeddedSdkEnabled(false);
    serverConfig.setNetworkMockableEnabled(false);
    iosGetInstanceSpy.mockRestore();
    androidGetInstanceSpy.mockRestore();
  });

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
      expect(result.error.issues[0].message).toBe("durationSeconds is required unless cancel is true");
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

  test("mockNetwork creates an iOS rule and syncs through IOSCtrlProxyClient", async () => {
    const tool = ToolRegistry.getTool("mockNetwork");

    const response = await tool!.deviceAwareHandler!(iosDevice, {
      host: "api\\.example\\.com",
      path: "^/v1/items",
      method: "GET",
      limit: 2,
      statusCode: 500,
      responseHeaders: { "x-test": "yes" },
      responseBody: "{\"error\":\"mocked\"}",
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
      rules: [{
        mockId: "mock-1",
        host: "api\\.example\\.com",
        path: "^/v1/items",
        method: "GET",
        limit: 2,
        remaining: 2,
        statusCode: 500,
        responseHeaders: { "x-test": "yes" },
        responseBody: "{\"error\":\"mocked\"}",
        contentType: "application/json",
      }],
    });
  });

  test("mockNetwork keeps the network-mockable gate for iOS", async () => {
    serverConfig.setNetworkMockableEnabled(false);
    const tool = ToolRegistry.getTool("mockNetwork");

    await expect(tool!.deviceAwareHandler!(iosDevice, {
      host: ".*",
      path: ".*",
    })).rejects.toThrow("Network mocking is disabled. Start the server with --network-mockable to enable.");
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
    expect(JSON.parse(iosMessages[0]).rules.map((rule: { mockId: string }) => rule.mockId)).toEqual(["mock-2"]);
  });
});
