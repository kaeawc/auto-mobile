import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DevicePool } from "../../src/daemon/devicePool";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { AndroidCtrlProxyManager } from "../../src/utils/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import type { BootedDevice } from "../../src/models";

/**
 * #6069 — public-path guard for the residual ownership bypass.
 *
 * The connection already holds a live, issued device session (either an explicit
 * SessionToolBinding or an active autolock session); a device tool is then called
 * with a fabricated `sessionUuid` on the SAME connection. This drives the real
 * MCP server (src/server/index.ts) through the daemon-mode handler + ToolRegistry
 * device-aware pipeline — the actual public entry point — and asserts the
 * fabricated id is rejected rather than auto-assigned a pooled device.
 *
 * NOTE: this passes on origin/main as well: #6045's admitIssuedSessionForAutomation
 * (toolRegistry, immediately before createToolExecutionContext) already rejects a
 * never-issued id on both of these routes. It is a REGRESSION GUARD against that
 * admission being weakened, not a red→green reproduction — the bound-connection
 * bypass reported on hardware in #6069 could not be reproduced through any current
 * public route in this harness (see the PR discussion). It documents that the two
 * most likely routing preconditions ("active binding" and "active autolock") do
 * NOT let a fabricated id reach the pool-minting fallback.
 */
describe("unissued sessionUuid on a bound connection (#6069)", () => {
  let fixture: McpTestFixture | undefined;
  let sessionManager: SessionManager;
  let pool: DevicePool;
  let timer: FakeTimer;
  let origMgr: typeof AndroidCtrlProxyManager.getInstance;
  let origClient: typeof AndroidCtrlProxyClient.getInstance;

  const devices: BootedDevice[] = [
    { name: "Pixel A", platform: "android", deviceId: "emulator-5554" },
    { name: "Pixel B", platform: "android", deviceId: "emulator-5556" },
  ];
  let handlerDevices: string[] = [];

  beforeEach(async () => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", devices);
    pool = new DevicePool(sessionManager, "daemon-test", timer, undefined, fakeDeviceUtils);
    await pool.initializeWithDevices(devices);
    DaemonState.getInstance().initialize(sessionManager, pool);

    origMgr = AndroidCtrlProxyManager.getInstance;
    origClient = AndroidCtrlProxyClient.getInstance;
    AndroidCtrlProxyManager.getInstance = () =>
      ({ resetSetupState: () => {}, setup: async () => ({ success: true, message: "ok" }) }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;
    AndroidCtrlProxyClient.resetInstances();

    handlerDevices = [];
    ToolRegistry.clearTools();
    ToolRegistry.registerDeviceAware(
      "observeProbe",
      "observeProbe",
      z.object({ sessionUuid: z.string().optional(), platform: z.string().optional() }).strict(),
      async (device: BootedDevice) => {
        handlerDevices.push(device.deviceId);
        return {
          content: [{ type: "text" as const, text: device.deviceId }],
          structuredContent: { deviceId: device.deviceId },
        };
      },
    );

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
    AndroidCtrlProxyManager.getInstance = origMgr;
    AndroidCtrlProxyClient.getInstance = origClient;
    AndroidCtrlProxyClient.resetInstances();
  });

  test("rejects a fabricated sessionUuid and never assigns a second pooled device", async () => {
    const { client } = fixture!.getContext();

    // 1) Acquire a real, issued session S1 on emulator-5554 and use it once so
    // the connection binds to it (index.ts SessionToolBinding). This is the
    // "connection already holds an active session" precondition.
    await sessionManager.createSession("S1", "emulator-5554", "android");
    const first = (await client.request(
      { method: "tools/call", params: { name: "observeProbe", arguments: { sessionUuid: "S1" } } },
      z.any(),
    )) as { isError?: boolean };
    expect(first.isError ?? false).toBe(false);
    expect(handlerDevices).toEqual(["emulator-5554"]); // ran on the caller's device

    const assignedBefore = pool.getDevice("emulator-5556")?.sessionId ?? null;
    expect(assignedBefore).toBeNull(); // the other pooled device is still idle

    // 2) On the SAME connection, call the device tool with a never-issued id.
    let rejected = false;
    let result: { isError?: boolean } | undefined;
    try {
      result = (await client.request(
        {
          method: "tools/call",
          params: { name: "observeProbe", arguments: { sessionUuid: "kumquat-D" } },
        },
        z.any(),
      )) as { isError?: boolean };
    } catch {
      rejected = true;
    }

    // The fabricated id must NOT have been minted a pooled device...
    expect(sessionManager.getSession("kumquat-D")).toBeNull();
    expect(pool.getDevice("emulator-5556")?.sessionId ?? null).toBeNull();
    // ...the handler must NOT have run on a second, foreign device...
    expect(handlerDevices).toEqual(["emulator-5554"]);
    // ...and the call surfaced the guard error rather than a foreign screen.
    expect(rejected || result?.isError === true).toBe(true);

    // The caller's own session is untouched.
    expect(sessionManager.getSession("S1")?.assignedDevice).toBe("emulator-5554");
  });

  test("rejects a fabricated sessionUuid while an autolock session is active on the connection", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    try {
      const { client } = fixture!.getContext();

      // An autolock session is the connection's active session (implicit binding
      // via the mcp session id), not an explicit SessionToolBinding.
      const autolockSessionId = await pool.autolockDevice("emulator-5554", "android", "conn-1");
      expect(sessionManager.getSession(autolockSessionId)?.assignedDevice).toBe("emulator-5554");

      let rejected = false;
      let result: { isError?: boolean } | undefined;
      try {
        result = (await client.request(
          {
            method: "tools/call",
            params: {
              name: "observeProbe",
              arguments: { sessionUuid: "kumquat-D", __mcpSessionId: "conn-1" },
            },
          },
          z.any(),
        )) as { isError?: boolean };
      } catch {
        rejected = true;
      }

      expect(sessionManager.getSession("kumquat-D")).toBeNull();
      expect(pool.getDevice("emulator-5556")?.sessionId ?? null).toBeNull();
      expect(handlerDevices).not.toContain("emulator-5556");
      expect(rejected || result?.isError === true).toBe(true);
    } finally {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    }
  });
});
