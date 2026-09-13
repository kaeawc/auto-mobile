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
      z
        .object({
          sessionUuid: z.string().optional(),
          platform: z.string().optional(),
          device: z.string().optional(),
        })
        .strict(),
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

  test("rejects routing to a FOREIGN live session once the connection is bound (#6069 red→green)", async () => {
    const { client } = fixture!.getContext();

    // The connection acquires and binds its own session S1 on emulator-5554.
    await sessionManager.createSession("S1", "emulator-5554", "android");
    const first = (await client.request(
      { method: "tools/call", params: { name: "observeProbe", arguments: { sessionUuid: "S1" } } },
      z.any(),
    )) as { isError?: boolean };
    expect(first.isError ?? false).toBe(false);
    expect(handlerDevices).toEqual(["emulator-5554"]);

    // A DIFFERENT, genuinely-issued session F1 exists on the OTHER pooled device
    // (e.g. left by earlier fleet activity / another connection). Because it is a
    // real live session, admitIssuedSessionForAutomation would happily admit it —
    // so the #6045/#6079 admission guard does NOT reject this id. Before the fix,
    // the connection bound to S1 could still route this call to F1 and run against
    // emulator-5556, a device this connection never acquired.
    await sessionManager.createSession("F1", "emulator-5556", "android");

    let rejected = false;
    let result: { isError?: boolean } | undefined;
    try {
      result = (await client.request(
        {
          method: "tools/call",
          params: { name: "observeProbe", arguments: { sessionUuid: "F1" } },
        },
        z.any(),
      )) as { isError?: boolean };
    } catch {
      rejected = true;
    }

    // The call must be rejected by the connection-binding guard...
    expect(rejected || result?.isError === true).toBe(true);
    // ...and must NOT have run on the foreign device the connection never bound.
    expect(handlerDevices).toEqual(["emulator-5554"]);
    // Both sessions keep their own devices; nothing was re-routed or re-assigned.
    expect(sessionManager.getSession("S1")?.assignedDevice).toBe("emulator-5554");
    expect(sessionManager.getSession("F1")?.assignedDevice).toBe("emulator-5556");
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
  test.each(["forwarded", "direct", "direct-spoof"] as const)(
    "rejects a genuinely issued foreign session on an autolock %s connection",
    async (route) => {
      const previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
      try {
        if (route !== "forwarded") {
          await fixture!.teardown();
          fixture = new McpTestFixture({
            daemonMode: false,
            sessionContext: { sessionId: "direct-conn-1" },
          });
          await fixture.setup();
        }
        const connectionId = route !== "forwarded" ? "direct-conn-1" : "forwarded-conn-1";
        const { client } = fixture!.getContext();

        // An autolock session is the connection's active session (implicit binding
        // via the mcp session id), not an explicit SessionToolBinding.
        const autolockSessionId = await pool.autolockDevice(
          "emulator-5554",
          "android",
          connectionId,
        );
        expect(sessionManager.getSession(autolockSessionId)?.assignedDevice).toBe("emulator-5554");

        await sessionManager.createSession("F1", "emulator-5556", "android");
        let rejected = false;
        let result: { isError?: boolean } | undefined;
        try {
          result = (await client.request(
            {
              method: "tools/call",
              params: {
                name: "observeProbe",
                arguments: {
                  sessionUuid: "F1",
                  ...(route === "forwarded" ? { __mcpSessionId: connectionId } : {}),
                  ...(route === "direct-spoof"
                    ? { __mcpSessionId: "forged-unbound-connection" }
                    : {}),
                },
              },
            },
            z.any(),
          )) as { isError?: boolean };
        } catch {
          rejected = true;
        }

        expect(handlerDevices).not.toContain("emulator-5556");
        expect(rejected || result?.isError === true).toBe(true);
      } finally {
        if (previousAutolock === undefined) {
          delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
        } else {
          process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
        }
      }
    },
  );
  test("allows an autolock owner's explicit session and allocated second-device label", async () => {
    const previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    try {
      const { client } = fixture!.getContext();
      const ownSession = await pool.autolockDevice("emulator-5554", "android", "forwarded-conn-1");
      expect(ownSession).toBeDefined();
      const secondSession = `${ownSession}:B`;
      await sessionManager.createSession(secondSession, "emulator-5556", "android");
      sessionManager.setDeviceLabels(ownSession!, { A: ownSession!, B: secondSession });
      for (const device of ["A", "B"]) {
        const result = await client.request(
          {
            method: "tools/call",
            params: {
              name: "observeProbe",
              arguments: {
                sessionUuid: ownSession,
                device,
                __mcpSessionId: "forwarded-conn-1",
              },
            },
          },
          z.any(),
        );
        expect(result.isError ?? false).toBe(false);
      }
      expect(handlerDevices).toEqual(["emulator-5554", "emulator-5556"]);
      expect(sessionManager.getSession(ownSession!)?.assignedDevice).toBe("emulator-5554");
      expect(sessionManager.getSession(secondSession)?.assignedDevice).toBe("emulator-5556");
    } finally {
      if (previousAutolock === undefined) {
        delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      } else {
        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
      }
    }
  });
});
