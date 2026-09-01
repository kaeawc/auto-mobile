import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { executionTracker } from "../../src/server/executionTracker";
import { DevicePool } from "../../src/daemon/devicePool";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

const captureSchema = z
  .object({
    value: z.string().optional(),
  })
  .strict();

async function callCaptureTool(
  fixture: McpTestFixture,
  args: Record<string, unknown>,
  whileHandling?: (handlerArgs: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  let capturedArgs: Record<string, unknown> | undefined;
  ToolRegistry.clearTools();
  ToolRegistry.register(
    "captureMcpSession",
    "captureMcpSession",
    captureSchema,
    async (handlerArgs) => {
      capturedArgs = handlerArgs;
      whileHandling?.(handlerArgs);
      return { content: [{ type: "text", text: "ok" }] };
    },
  );

  const { client } = fixture.getContext();
  await client.request(
    {
      method: "tools/call",
      params: {
        name: "captureMcpSession",
        arguments: args,
      },
    },
    z.any(),
  );

  expect(capturedArgs).toBeDefined();
  return capturedArgs!;
}

describe("MCP session autolock routing", () => {
  let fixture: McpTestFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.teardown();
      fixture = undefined;
    }
    ToolRegistry.clearTools();
  });

  test("strips proxy-injected session keys before schema validation and passes them to handlers", async () => {
    fixture = new McpTestFixture({
      daemonMode: true,
      sessionContext: { sessionId: "shared-loopback-session" },
    });
    await fixture.setup();

    const capturedArgs = await callCaptureTool(fixture, {
      value: "ok",
      __mcpSessionId: "unix-socket-session",
    });

    expect(capturedArgs.value).toBe("ok");
    expect(capturedArgs.__mcpSessionId).toBe("unix-socket-session");
  });

  test("tracks proxy-injected MCP sessions under their autolock key", async () => {
    fixture = new McpTestFixture({
      daemonMode: true,
      sessionContext: { sessionId: "shared-loopback-session" },
    });
    await fixture.setup();

    await callCaptureTool(fixture, { value: "ok", __mcpSessionId: "unix-socket-session" }, () => {
      expect(executionTracker.hasActiveSessionExecutions("unix-socket-session")).toBe(true);
      // The forwarded key drives autolock expiry, while the transport key is
      // retained solely so its close/error handlers can cancel this execution.
      expect(executionTracker.hasActiveSessionExecutions("shared-loopback-session")).toBe(true);
    });
  });

  test("binds an implicit execution to its resolved autolock before an MCP remap", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT = "60";
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const fakeDeviceUtils = new FakeDeviceUtils();
    const devices = [
      { name: "Pixel 7", platform: "android" as const, deviceId: "emulator-5554" },
      { name: "Pixel 8", platform: "android" as const, deviceId: "emulator-5556" },
    ];
    fakeDeviceUtils.setBootedDevices("android", devices);
    const pool = new DevicePool(sessionManager, "daemon-test", timer, undefined, fakeDeviceUtils);
    await pool.initializeWithDevices(devices);
    DaemonState.getInstance().initialize(sessionManager, pool);
    const originalSessionId = await pool.autolockDevice("emulator-5554", "android", "mcp-session");
    const handlerStarted = Promise.withResolvers<void>();
    const releaseHandler = Promise.withResolvers<void>();

    ToolRegistry.clearTools();
    ToolRegistry.registerDeviceAware(
      "captureAutolockOwnership",
      "captureAutolockOwnership",
      captureSchema,
      async () => {
        handlerStarted.resolve();
        await releaseHandler.promise;
        return { content: [{ type: "text", text: "ok" }] };
      },
    );
    fixture = new McpTestFixture({ sessionContext: { sessionId: "mcp-session" } });
    await fixture.setup();

    const { client } = fixture.getContext();
    const request = client.request(
      {
        method: "tools/call",
        params: { name: "captureAutolockOwnership", arguments: {} },
      },
      z.any(),
    );
    await handlerStarted.promise;

    const replacementSessionId = await pool.autolockDevice(
      "emulator-5556",
      "android",
      "mcp-session",
    );
    expect(executionTracker.hasActiveAutolockSessionExecutions(originalSessionId!)).toBe(true);
    expect(executionTracker.hasActiveAutolockSessionExecutions(replacementSessionId!)).toBe(false);

    sessionManager.setActiveSessionExecutionChecker(
      (sessionUuid) =>
        executionTracker.hasActiveSessionUuidExecutions(sessionUuid) ||
        executionTracker.hasActiveAutolockSessionExecutions(sessionUuid),
    );
    timer.advanceTime(60_001);
    expect(sessionManager.getSession(originalSessionId!)).not.toBeNull();
    expect(sessionManager.getSession(replacementSessionId!)).toBeNull();

    releaseHandler.resolve();
    await request;
    sessionManager.stopCleanupTimer();
    DaemonState.getInstance().reset();
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    delete process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT;
  });

  test("does not use the shared daemon loopback MCP session as an implicit autolock key", async () => {
    fixture = new McpTestFixture({
      daemonMode: true,
      sessionContext: { sessionId: "shared-loopback-session" },
    });
    await fixture.setup();

    const capturedArgs = await callCaptureTool(fixture, { value: "ok" });

    expect(capturedArgs.value).toBe("ok");
    expect(capturedArgs).not.toHaveProperty("__mcpSessionId");
  });

  test("keeps direct MCP sessions available as implicit autolock keys", async () => {
    fixture = new McpTestFixture({ sessionContext: { sessionId: "direct-mcp-session" } });
    await fixture.setup();

    const capturedArgs = await callCaptureTool(fixture, { value: "ok" });

    expect(capturedArgs.value).toBe("ok");
    expect(capturedArgs.__mcpSessionId).toBe("direct-mcp-session");
  });
});
