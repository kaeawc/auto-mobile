import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { INTERNAL_MCP_SESSION_PARAM } from "../../src/daemon/constants";
import { DEVICE_OUTSIDE_MANAGED_SLOTS_CODE } from "../../src/daemon/managedSlots/managedSlotRefusal";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { DEVICE_OUTSIDE_BOUND_SESSION_CODE } from "../../src/server/deviceOutsideBoundSessionRefusal";
import {
  registerDirectSessionDevice,
  unregisterDirectSession,
} from "../../src/server/directSessionDeviceRegistry";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";

/**
 * #11292: typed refusals thrown while `executeToolCall` routes a call (before its main `try`)
 * must reach the client through the real `tools/call` dispatch as the typed result, not as an
 * untyped -32603 error. Driven through the real MCP server over an in-memory transport.
 */
const BOUND_SESSION = "bound-ios-session";
const iosDevice: BootedDevice = { name: "iPhone", deviceId: "IOS-BOUND", platform: "ios" };
const PROBE_TOOL = "__typed_refusal_probe__";

function wire(result: { content?: unknown }): Record<string, unknown> {
  const content = result.content as { text: string }[];
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe("typed refusals thrown before executeToolCall's try (#11292)", () => {
  let restoreHermeticServer: () => void;
  let fixture: McpTestFixture | undefined;

  beforeAll(async () => {
    // Pay the server module's cold import and tool registration outside any test's budget.
    const restore = installHermeticServerFixture();
    const warm = new McpTestFixture();
    await warm.setup();
    await warm.teardown();
    restore();
  });

  beforeEach(() => {
    restoreHermeticServer = installHermeticServerFixture();
  });

  afterEach(async () => {
    await fixture?.teardown();
    fixture = undefined;
    unregisterDirectSession(BOUND_SESSION);
    DaemonState.getInstance().reset();
    restoreHermeticServer();
  });

  test("device_outside_bound_session arrives as a typed result", async () => {
    registerDirectSessionDevice(BOUND_SESSION, iosDevice);
    fixture = new McpTestFixture({ sessionContext: { initialSessionToolBinding: BOUND_SESSION } });
    await fixture.setup();

    const result = await fixture.client.callTool({
      name: "tapOn",
      arguments: { platform: "android", text: "x" },
    });

    expect(result.isError).toBe(true);
    expect(wire(result)).toMatchObject({
      success: false,
      code: DEVICE_OUTSIDE_BOUND_SESSION_CODE,
      boundSessionUuid: BOUND_SESSION,
      boundDeviceId: iosDevice.deviceId,
      retryable: false,
    });
  });

  test("device_outside_managed_slots arrives as a typed result", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "typed-refusal-before-try", {
        timer,
        deviceManager: new FakeDeviceUtils(),
      }),
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    DaemonState.getInstance()
      .getManagedConnectionScopes()
      .bind("mcp-managed", { scopeKey: "scope-a", sessionUuids: [] });
    fixture = new McpTestFixture({ daemonMode: true });
    await fixture.setup();

    const result = await fixture.client.callTool({
      name: "setActiveDevice",
      arguments: { deviceId: "OTHER-DEVICE", [INTERNAL_MCP_SESSION_PARAM]: "mcp-managed" },
    });

    expect(result.isError).toBe(true);
    expect(wire(result)).toMatchObject({
      success: false,
      code: DEVICE_OUTSIDE_MANAGED_SLOTS_CODE,
      retryable: false,
    });
    sessionManager.stopCleanupTimer();
  });

  test("an untyped pre-try failure still throws the MCP error", async () => {
    ToolRegistry.register(PROBE_TOOL, "probe", z.object({}), async () => ({ content: [] }));
    fixture = new McpTestFixture();
    await fixture.setup();

    await expect(
      fixture.client.callTool({ name: "__no_such_tool__", arguments: {} }),
    ).rejects.toThrow(/Unknown tool/);
  });
});
