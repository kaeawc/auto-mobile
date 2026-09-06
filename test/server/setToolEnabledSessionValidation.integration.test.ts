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
 *
 * Round 2 (post-review): the first fix exempted setToolEnabled from the gate
 * whenever the explicit `sessionUuid` matched the connection's
 * `connectionProfileUuid` — but that profile uuid carries NO server-verified
 * provenance. src/daemon/daemon.ts threads it straight from a raw,
 * caller-controlled HTTP header (DAEMON_TOOL_SELECTION_PROFILE_HEADER) into
 * `sessionContext.initialToolSelectionProfile` with no issuance check, so a
 * proxied caller could set that header to the same fabricated string it also
 * sends as `arguments.sessionUuid` and satisfy the equality — reopening the
 * exact hole this fix closes. The fix now has NO exemption: every explicit
 * `sessionUuid` argument to setToolEnabled clears the same admission check
 * every sibling plain session tool already enforces, self-referential or not.
 */
describe("setToolEnabled sessionUuid validation (#6148)", () => {
  let sessionManager: SessionManager;
  let pool: DevicePool;
  let timer: FakeTimer;
  let fixture: McpTestFixture | undefined;

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
    fixture = new McpTestFixture({ daemonMode: true, sessionContext: { sessionId: "conn-1" } });
    await fixture.setup();
    const { client } = fixture.getContext();

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
    fixture = new McpTestFixture({ daemonMode: true, sessionContext: { sessionId: "conn-1" } });
    await fixture.setup();
    const { client } = fixture.getContext();
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

  test("rejects a crafted sessionUuid that matches an unissued, caller-supplied tool-selection profile", async () => {
    // Simulates a proxied caller that controls BOTH the connection's
    // tool-selection-profile header (-> sessionContext.initialToolSelectionProfile,
    // exactly as src/daemon/daemon.ts threads DAEMON_TOOL_SELECTION_PROFILE_HEADER)
    // and the `arguments.sessionUuid` on the same tools/call request, setting
    // both to the identical fabricated, never-issued string.
    const fabricated = "attacker-fabricated-profile-uuid";
    fixture = new McpTestFixture({
      daemonMode: true,
      sessionContext: { sessionId: "conn-attacker", initialToolSelectionProfile: fabricated },
    });
    await fixture.setup();
    const { client } = fixture.getContext();

    await expect(
      client.request(
        {
          method: "tools/call",
          params: {
            name: "setToolEnabled",
            arguments: { toolName: "clipboard", enabled: true, sessionUuid: fabricated },
          },
        },
        z.any(),
      ),
    ).rejects.toThrow("is not an active daemon session");
  });

  test("a legitimate profile-only update (no explicit sessionUuid argument) still succeeds", async () => {
    // The real cross-connection resume path never puts the profile uuid in
    // `arguments.sessionUuid` — it flows solely through
    // sessionContext.initialToolSelectionProfile (the header). Omitting the
    // argument must still work: the admission gate never triggers because
    // providedSessionUuid is undefined.
    fixture = new McpTestFixture({
      daemonMode: true,
      sessionContext: {
        sessionId: "conn-legit",
        initialToolSelectionProfile: "server-issued-profile-uuid",
      },
    });
    await fixture.setup();
    const { client } = fixture.getContext();

    const result = (await client.request(
      {
        method: "tools/call",
        params: {
          name: "setToolEnabled",
          arguments: { toolName: "clipboard", enabled: true },
        },
      },
      z.any(),
    )) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };

    expect(result.isError ?? false).toBe(false);
    const text = result.content?.find((c) => c.type === "text")?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({
      sessionUuid: "server-issued-profile-uuid",
      toolName: "clipboard",
      enabled: true,
    });
  });
});
