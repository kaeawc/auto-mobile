import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerToolSelectionTools } from "../../src/server/toolSelectionTools";
import { DevicePool } from "../../src/daemon/devicePool";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import type { BootedDevice } from "../../src/models";

/**
 * #6148 (#6069 residual) — `setToolEnabled` must reject a never-issued
 * sessionUuid with the same "not an active daemon session" error every other
 * plain session tool (e.g. `listDevices`) already gets from the
 * `admitIssuedSessionForAutomation` gate in src/server/index.ts, instead of
 * silently reporting success.
 */
describe("setToolEnabled sessionUuid validation (#6148)", () => {
  let fixture: McpTestFixture | undefined;
  let sessionManager: SessionManager;
  let pool: DevicePool;
  let timer: FakeTimer;

  const devices: BootedDevice[] = [
    { name: "Pixel A", platform: "android", deviceId: "emulator-5554" },
  ];

  beforeEach(async () => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", devices);
    pool = new DevicePool(sessionManager, "daemon-test", timer, undefined, fakeDeviceUtils);
    await pool.initializeWithDevices(devices);
    DaemonState.getInstance().initialize(sessionManager, pool);

    ToolRegistry.clearTools();
    ToolRegistry.register(
      "clipboard",
      "clipboard",
      z.object({ sessionUuid: z.string().optional() }),
      async () => ({ content: [{ type: "text" as const, text: "clipboard" }] }),
      { defaultEnabled: false },
    );
    registerToolSelectionTools();

    fixture = new McpTestFixture({ daemonMode: true, sessionContext: { sessionId: "conn-1" } });
    await fixture.setup();
  });

  afterEach(async () => {
    if (fixture) {
      await fixture.teardown();
      fixture = undefined;
    }
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  });

  test("rejects a never-issued sessionUuid instead of reporting success", async () => {
    const { client } = fixture!.getContext();

    await expect(
      client.request(
        {
          method: "tools/call",
          params: {
            name: "setToolEnabled",
            arguments: {
              toolName: "clipboard",
              enabled: true,
              sessionUuid: "deadbeef-0000-4000-8000-000000000000",
            },
          },
        },
        z.any(),
      ),
    ).rejects.toThrow("is not an active daemon session");
  });

  test("accepts a valid, previously-issued sessionUuid", async () => {
    const { client } = fixture!.getContext();
    await sessionManager.createSession("S1", "emulator-5554", "android");

    const result = (await client.request(
      {
        method: "tools/call",
        params: {
          name: "setToolEnabled",
          arguments: { toolName: "clipboard", enabled: true, sessionUuid: "S1" },
        },
      },
      z.any(),
    )) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };

    expect(result.isError ?? false).toBe(false);
    const text = result.content?.find((c) => c.type === "text")?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({
      sessionUuid: "S1",
      toolName: "clipboard",
      enabled: true,
    });
  });
});
