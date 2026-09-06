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
 * exact hole this fix closes. Round 2 removed the exemption entirely.
 *
 * Round 3 (post-review): removing the exemption entirely broke the documented,
 * legitimate contract — "sessionUuid: ... Omit to update this MCP connection's
 * profile" — because a caller that first omits `sessionUuid` (server mints and
 * binds a profile) and then explicitly re-affirms that SAME server-minted
 * profile as `sessionUuid` was wrongly forced through device-session admission
 * and rejected. The fix now exempts setToolEnabled ONLY when the explicit
 * sessionUuid is a profile THIS server instance itself minted and bound for
 * this exact connection (`SessionToolBinding.isServerIssuedToolSelectionProfile`,
 * populated solely by `createAndBindToolSelectionProfile`) — never the
 * unauthenticated header fallback, which is what closes the round-2 hole.
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

  test("preserves an explicit update to a genuinely server-issued connection profile", async () => {
    // The client first OMITS sessionUuid entirely, so the server mints and
    // binds a fresh profile for this connection (createAndBindToolSelectionProfile).
    // A later call explicitly re-affirms that SAME server-minted uuid as
    // `sessionUuid` — this must succeed, not be forced through device-session
    // admission (it is not a device session; it never will be one).
    fixture = new McpTestFixture({ daemonMode: true, sessionContext: { sessionId: "conn-2" } });
    await fixture.setup();
    const { client } = fixture.getContext();

    const first = (await client.request(
      {
        method: "tools/call",
        params: {
          name: "setToolEnabled",
          arguments: { toolName: "clipboard", enabled: true },
        },
      },
      z.any(),
    )) as { content?: Array<{ type: string; text?: string }> };
    const mintedProfileUuid = JSON.parse(
      first.content?.find((c) => c.type === "text")?.text ?? "{}",
    ).sessionUuid as string;
    expect(typeof mintedProfileUuid).toBe("string");
    expect(mintedProfileUuid.length).toBeGreaterThan(0);

    const second = (await client.request(
      {
        method: "tools/call",
        params: {
          name: "setToolEnabled",
          arguments: { toolName: "clipboard", enabled: false, sessionUuid: mintedProfileUuid },
        },
      },
      z.any(),
    )) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };

    expect(second.isError ?? false).toBe(false);
    const secondText = second.content?.find((c) => c.type === "text")?.text ?? "";
    expect(JSON.parse(secondText)).toMatchObject({
      sessionUuid: mintedProfileUuid,
      toolName: "clipboard",
      enabled: false,
    });
  });
});
