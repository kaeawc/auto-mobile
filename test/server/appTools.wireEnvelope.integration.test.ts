import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/server";
import type { SetAppPermissionsResult } from "../../src/features/action/AppPermissions";
import { ResetKeychain } from "../../src/features/action/ResetKeychain";
import type { BootedDevice, ResetKeychainResult } from "../../src/models";
import {
  resetInstalledAppResourceRefresh,
  setInstalledAppResourceRefresh,
} from "../../src/server/appTools";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { isToolResponseFailure } from "../../src/server/pipeline/afterToolCall";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeArtifactWriter } from "../fakes/FakeArtifactWriter";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { createAppToolsHarness } from "../helpers/appToolsHarness";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";

/**
 * Pins the exact serialized CallTool result for the schema'd appTools responses
 * (installApp, uninstallApp, setAppPermissions, resetKeychain) as it leaves the server
 * transport (#11830): the text part, the retained `structuredContent`, the hoisted
 * `success`/`error`, and `isError` only on a change-free permission failure. The real
 * registered handlers run against fakes; the MCP boundary, the client's outputSchema
 * validation and the finalizer are production code. An envelope change that alters a
 * single wire byte, or a payload the declared outputSchema rejects, fails here.
 */
const device: BootedDevice = { name: "fake", deviceId: "fake-11830", platform: "android" };
const appTools = createAppToolsHarness();

const permissionResult = (
  success: boolean,
  changedCount: number,
  error?: string,
): SetAppPermissionsResult => ({
  success,
  appId: "com.example",
  deviceId: device.deviceId,
  platform: "android",
  action: "grant",
  changedCount,
  failedCount: success ? 0 : 1,
  operations: [],
  ...(error === undefined ? {} : { error }),
});

const keychainResult: ResetKeychainResult = {
  success: true,
  deviceId: device.deviceId,
  platform: "ios",
  requestedAppId: "com.example",
  scope: "all-apps",
  exceededRequestedScope: true,
  message: "Reset the keychain",
};

describe("appTools structured wire envelopes", () => {
  let fixture: McpTestFixture;
  let restoreHermetic: () => void;
  const wire: string[] = [];

  beforeAll(async () => {
    restoreHermetic = installHermeticServerFixture();
    fixture = new McpTestFixture({
      sessionToolSelectionService: {
        isEnabled: async () => true,
        getOverride: async () => undefined,
        setEnabled: async () => {},
        deleteSession: async () => {},
      },
    });
    await fixture.setup();
    // Caches the advertised outputSchemas, so the client validates every structuredContent.
    await fixture.client.listTools();
    const transport = fixture.serverTransport as { send(message: JSONRPCMessage): Promise<void> };
    const send = transport.send.bind(transport);
    transport.send = async (message: JSONRPCMessage) => {
      if ("result" in message) {
        wire.push(JSON.stringify(message.result));
      }
      return send(message);
    };
    setInstalledAppResourceRefresh({ invalidate: () => {}, notify: async () => {} });
  });

  afterAll(async () => {
    resetInstalledAppResourceRefresh();
    await fixture.teardown();
    restoreHermetic();
  });

  afterEach(() => {
    wire.length = 0;
  });

  /** Returns the serialized wire result and the pipeline's failure verdict on the handler result. */
  async function callOnWire(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ wire: string; failure: boolean }> {
    const tool = ToolRegistry.getRegisteredTool(name)!;
    expect(tool.outputSchema).toBeDefined();
    let failure: boolean | undefined;
    const handlerSpy = spyOn(tool, "handler").mockImplementation(async () => {
      const response = await tool.deviceAwareHandler!(device, args);
      failure = isToolResponseFailure(response);
      return finalizeToolResponse(response, {
        name,
        outputSchema: tool.outputSchema,
        artifactWriter: new FakeArtifactWriter(),
      });
    });
    try {
      wire.length = 0;
      await fixture.client.callTool({ name, arguments: args });
      expect(wire).toHaveLength(1);
      return { wire: wire[0], failure: failure! };
    } finally {
      handlerSpy.mockRestore();
    }
  }

  test("installApp success", async () => {
    appTools.configure("installApp", {
      createInstallApp: () => ({
        execute: async () => ({ success: true, packageName: "com.example", upgrade: false }),
      }),
    });
    expect(await callOnWire("installApp", { artifactPath: "/tmp/app.apk" })).toEqual({
      failure: false,
      wire: '{"content":[{"type":"text","text":"{\\"message\\":\\"Installed app from /tmp/app.apk\\",\\"success\\":true,\\"packageName\\":\\"com.example\\",\\"upgrade\\":false}"}],"structuredContent":{"message":"Installed app from /tmp/app.apk","success":true,"packageName":"com.example","upgrade":false},"success":true}',
    });
  });

  test("uninstallApp success", async () => {
    appTools.configure("uninstallApp", {
      createUninstallApp: () => ({
        execute: async () => ({
          success: true,
          packageName: "com.example",
          keepData: false,
          wasInstalled: true,
        }),
      }),
    });
    expect(await callOnWire("uninstallApp", { appId: "com.example" })).toEqual({
      failure: false,
      wire: '{"content":[{"type":"text","text":"{\\"message\\":\\"Uninstalled app com.example\\",\\"success\\":true,\\"packageName\\":\\"com.example\\",\\"keepData\\":false,\\"wasInstalled\\":true}"}],"structuredContent":{"message":"Uninstalled app com.example","success":true,"packageName":"com.example","keepData":false,"wasInstalled":true},"success":true}',
    });
  });

  test.each([
    [
      "success",
      permissionResult(true, 1),
      false,
      '{"content":[{"type":"text","text":"{\\"message\\":\\"Applied 1 app permission change(s) for com.example\\",\\"success\\":true,\\"appId\\":\\"com.example\\",\\"deviceId\\":\\"fake-11830\\",\\"platform\\":\\"android\\",\\"action\\":\\"grant\\",\\"changedCount\\":1,\\"failedCount\\":0,\\"operations\\":[]}"}],"structuredContent":{"message":"Applied 1 app permission change(s) for com.example","success":true,"appId":"com.example","deviceId":"fake-11830","platform":"android","action":"grant","changedCount":1,"failedCount":0,"operations":[]},"success":true}',
    ],
    [
      "partial failure",
      permissionResult(false, 1, "one denied"),
      true,
      '{"content":[{"type":"text","text":"{\\"message\\":\\"one denied\\",\\"success\\":false,\\"appId\\":\\"com.example\\",\\"deviceId\\":\\"fake-11830\\",\\"platform\\":\\"android\\",\\"action\\":\\"grant\\",\\"changedCount\\":1,\\"failedCount\\":1,\\"operations\\":[],\\"error\\":\\"one denied\\"}"}],"structuredContent":{"message":"one denied","success":false,"appId":"com.example","deviceId":"fake-11830","platform":"android","action":"grant","changedCount":1,"failedCount":1,"operations":[],"error":"one denied"},"success":false,"error":"one denied"}',
    ],
    [
      "whole failure",
      permissionResult(false, 0, "all denied"),
      true,
      '{"content":[{"type":"text","text":"{\\"message\\":\\"all denied\\",\\"success\\":false,\\"appId\\":\\"com.example\\",\\"deviceId\\":\\"fake-11830\\",\\"platform\\":\\"android\\",\\"action\\":\\"grant\\",\\"changedCount\\":0,\\"failedCount\\":1,\\"operations\\":[],\\"error\\":\\"all denied\\"}"}],"structuredContent":{"message":"all denied","success":false,"appId":"com.example","deviceId":"fake-11830","platform":"android","action":"grant","changedCount":0,"failedCount":1,"operations":[],"error":"all denied"},"isError":true,"success":false,"error":"all denied"}',
    ],
  ] as const)("setAppPermissions %s", async (_label, result, failure, expected) => {
    appTools.configure("appPermissionsFactory", () => ({ setPermissions: async () => result }));
    expect(
      await callOnWire("setAppPermissions", {
        appId: "com.example",
        action: "grant",
        permissions: ["android.permission.CAMERA"],
      }),
    ).toEqual({ wire: expected, failure });
  });

  test("resetKeychain success", async () => {
    const execute = spyOn(ResetKeychain.prototype, "execute").mockResolvedValue(keychainResult);
    try {
      expect(
        await callOnWire("resetKeychain", {
          appId: "com.example",
          confirm: true,
          deviceId: device.deviceId,
        }),
      ).toEqual({
        failure: false,
        wire: '{"content":[{"type":"text","text":"{\\"success\\":true,\\"deviceId\\":\\"fake-11830\\",\\"platform\\":\\"ios\\",\\"requestedAppId\\":\\"com.example\\",\\"scope\\":\\"all-apps\\",\\"exceededRequestedScope\\":true,\\"message\\":\\"Reset the keychain\\"}"}],"structuredContent":{"success":true,"deviceId":"fake-11830","platform":"ios","requestedAppId":"com.example","scope":"all-apps","exceededRequestedScope":true,"message":"Reset the keychain"},"success":true}',
      });
    } finally {
      execute.mockRestore();
    }
  });
});
