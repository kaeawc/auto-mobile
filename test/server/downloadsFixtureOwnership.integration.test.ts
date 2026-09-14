import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerDownloadsFixtureTools } from "../../src/server/downloadsFixtureTools";
import { DevicePool } from "../../src/daemon/devicePool";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DownloadsFixtureService } from "../../src/server/downloadsFixtureService";
import type { BootedDevice } from "../../src/models";

/**
 * #7007 P1 — a connection bound to session A must not be able to stage into
 * another live session B's Downloads.
 *
 * Because `stageSessionDownloads` is registered device-aware (`requiresDevice`),
 * the MCP boundary's #6069 cross-session ownership guard runs and rejects a
 * foreign `sessionUuid` BEFORE the handler (and thus the service, which is where
 * the device would be mutated) is ever reached. The fake service records every
 * `stage()` call, so "zero mutation" is asserted directly: it is only ever
 * called for the connection's own session.
 */
describe("stageSessionDownloads cross-session ownership (#7007)", () => {
  let fixture: McpTestFixture | undefined;
  let sessionManager: SessionManager;
  let pool: DevicePool;
  let timer: FakeTimer;
  let stagedSessions: string[];

  const devices: BootedDevice[] = [
    { name: "Pixel A", platform: "android", deviceId: "emulator-5554" },
    { name: "Pixel B", platform: "android", deviceId: "emulator-5556" },
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

    stagedSessions = [];
    const fakeService: DownloadsFixtureService = {
      stage: async (request) => {
        stagedSessions.push(request.sessionUuid ?? "");
        return {
          success: true,
          sessionUuid: request.sessionUuid ?? "",
          deviceId: "emulator-5554",
          platform: "android",
          directory: request.directory,
          userId: 0,
          userSource: "primary",
          destinationDirectory: `/storage/emulated/0/Download/${request.directory}`,
          reset: request.reset ?? false,
          files: [],
        };
      },
    };

    fixture = new McpTestFixture({
      daemonMode: true,
      sessionContext: { sessionId: "conn-1" },
      // The tool is opt-in (defaultEnabled: false); enable it so the legitimate
      // first call reaches the handler and binds the connection to its session.
      sessionToolSelectionService: {
        isEnabled: async (_sessionUuid, toolName, declaredDefault) =>
          toolName === "stageSessionDownloads" ? true : declaredDefault,
        getOverride: async (_sessionUuid, toolName) =>
          toolName === "stageSessionDownloads" ? true : undefined,
        setEnabled: async () => {},
        deleteSession: async () => {},
      },
    });
    await fixture.setup();
    // createMcpServer() (inside setup) re-registers every real tool, so install
    // the fake service AFTER setup to override the default-service registration.
    // callTool resolves the tool by name at call time, so this takes effect.
    registerDownloadsFixtureTools(() => fakeService);
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

  test("refuses staging into a FOREIGN live session before touching any device", async () => {
    const { client } = fixture!.getContext();

    // The connection acquires and binds its own session S1 on emulator-5554 by
    // staging into it once (this is the "connection already holds an active
    // session" precondition the guard keys on).
    await sessionManager.createSession("S1", "emulator-5554", "android");
    const first = (await client.request(
      {
        method: "tools/call",
        params: {
          name: "stageSessionDownloads",
          arguments: {
            sessionUuid: "S1",
            directory: "run-own",
            files: [{ contentText: "own", destinationPath: "own.txt" }],
          },
        },
      },
      z.any(),
    )) as { isError?: boolean };
    expect(first.isError ?? false).toBe(false);
    expect(stagedSessions).toEqual(["S1"]);

    // A DIFFERENT, genuinely-issued session F1 exists on the OTHER pooled device
    // (left by another connection / fleet activity). Before the fix the plain
    // tool would resolve F1 globally and, with reset:true, delete/overwrite F1's
    // Downloads fixtures.
    await sessionManager.createSession("F1", "emulator-5556", "android");

    let rejected = false;
    let result: { isError?: boolean } | undefined;
    try {
      result = (await client.request(
        {
          method: "tools/call",
          params: {
            name: "stageSessionDownloads",
            arguments: {
              sessionUuid: "F1",
              directory: "run-foreign",
              reset: true,
              files: [{ contentText: "attacker", destinationPath: "attacker.txt" }],
            },
          },
        },
        z.any(),
      )) as { isError?: boolean };
    } catch {
      rejected = true;
    }

    // The call is refused by the ownership guard...
    expect(rejected || result?.isError === true).toBe(true);
    // ...and the service (the only place a device is mutated) was NEVER invoked
    // for F1 — zero mutation of the foreign session's Downloads.
    expect(stagedSessions).toEqual(["S1"]);
    // Both sessions keep their own devices; nothing was re-routed or re-assigned.
    expect(sessionManager.getSession("S1")?.assignedDevice).toBe("emulator-5554");
    expect(sessionManager.getSession("F1")?.assignedDevice).toBe("emulator-5556");
  });
});
