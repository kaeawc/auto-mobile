import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";

/**
 * A plain (non-device) read that names a session only watches it (#11107): it is admitted
 * read-only, so polling it never counts as session activity and cannot hold the device past its
 * idle window. A plain control call still does.
 */
describe("plain tool read/control session activity (#11107)", () => {
  const device: BootedDevice = { name: "Pixel A", platform: "android", deviceId: "emulator-5554" };
  let restoreHermeticServer: () => void;
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let fixture: McpTestFixture | undefined;
  let sessionUuid: string;

  beforeAll(async () => {
    restoreHermeticServer = installHermeticServerFixture();
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const deviceUtils = new FakeDeviceUtils();
    deviceUtils.setBootedDevices("android", [device]);
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-test", {
        timer,
        deviceManager: deviceUtils,
      }),
    );
    await pool.initializeWithDevices([device]);
    DaemonState.getInstance().initialize(sessionManager, pool);

    ToolRegistry.clearTools();
    const schema = z.object({ sessionUuid: z.string().optional(), action: z.string().optional() });
    const handler = async () => ({ content: [{ type: "text" as const, text: "ok" }] });
    ToolRegistry.register("plainRead", "read", schema, handler, { readOnly: true });
    ToolRegistry.register("plainMixed", "mixed", schema, handler, {
      readOnly: (args: { action?: string }) => args.action === "status",
    });
    ToolRegistry.register("plainControl", "control", schema, handler);

    fixture = new McpTestFixture({ daemonMode: true, sessionContext: { sessionId: "conn-1" } });
    await fixture.setup();
    // Pay the first-call warm-up here: beforeAll is outside the per-test budget.
    sessionUuid = (await sessionManager.createSession("warm-up", device.deviceId, "android"))
      .sessionId;
    await call("plainControl");
    await sessionManager.releaseSession(sessionUuid);
  });

  afterAll(async () => {
    await fixture?.teardown();
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
    restoreHermeticServer();
  });

  beforeEach(async () => {
    sessionUuid = (
      await sessionManager.createSession(`held-${timer.now()}`, device.deviceId, "android")
    ).sessionId;
  });

  afterEach(async () => {
    await sessionManager.releaseSession(sessionUuid);
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await fixture!
      .getContext()
      .client.request(
        { method: "tools/call", params: { name, arguments: { sessionUuid, ...args } } },
        z.any(),
      );
    expect(response.isError).not.toBe(true);
  };

  const activity = () => {
    const session = sessionManager.getSession(sessionUuid)!;
    return { lastUsedAt: session.lastUsedAt, expiresAt: session.expiresAt };
  };

  test("plain reads naming the session never refresh its activity", async () => {
    const before = activity();
    timer.advanceTime(30_000);
    await call("plainRead");
    await call("plainMixed", { action: "status" });

    expect(activity()).toEqual(before);
  });

  test("a plain control call naming the session is activity", async () => {
    const before = activity();
    timer.advanceTime(30_000);
    await call("plainMixed", { action: "begin" });

    expect(activity().lastUsedAt).toBe(before.lastUsedAt + 30_000);
    expect(activity().expiresAt).toBeGreaterThan(before.expiresAt);
  });
});
