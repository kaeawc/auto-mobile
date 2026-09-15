import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { DeviceSessionPersistence } from "../../src/db/deviceSessionRepository";
import type { DeviceSession } from "../../src/db/types";
import type { DevicePool } from "../../src/daemon/devicePool";
import { DaemonState } from "../../src/daemon/daemonState";
import {
  SessionManager,
  SessionRecoveryIdentityLossError,
  type SessionDeviceAssigner,
} from "../../src/daemon/sessionManager";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { FakeTimer } from "../fakes/FakeTimer";

const TOOL = "__terminal_persisted_recovery_probe__";
const SESSION_UUID = "persisted-target-busy-session";
const TERMINAL_DIAGNOSTIC =
  `Session ${SESSION_UUID} is terminal after identity-recovery-target-busy and cannot be reused. ` +
  "Acquire a new device with getAndroid or getApple.";

describe("terminal persisted recovery MCP transport", () => {
  let fixture: McpTestFixture | undefined;
  let sessionManager: SessionManager | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.teardown();
      fixture = undefined;
    }
    ToolRegistry.unregister(TOOL);
    DaemonState.getInstance().reset();
    sessionManager?.stopCleanupTimer();
    sessionManager = undefined;
  });

  test("returns the durable target-busy diagnostic on the second admitted MCP call", async () => {
    const timer = new FakeTimer();
    const persisted: DeviceSession = {
      session_uuid: SESSION_UUID,
      device_id: "emulator-5554",
      stable_device_id: "Pixel_8_API_35",
      platform: "android",
      status: "expired",
      source: "session-manager",
      autolock_enabled: 0,
      mcp_session_id: null,
      daemon_session_id: "before-restart",
      created_at_ms: 1,
      last_used_at_ms: 20,
      expires_at_ms: 30,
      released_at_ms: 25,
      release_reason: "daemon-restart",
      session_timeout_ms: 10,
      heartbeat_timeout_ms: 5,
      has_received_heartbeat: 1,
      created_at: "2026-09-15T00:00:00.000Z",
      updated_at: "2026-09-15T00:00:00.000Z",
    };
    const persistence: DeviceSessionPersistence = {
      async getSession() {
        return persisted;
      },
      async upsertActiveSession() {
        throw new Error("target-busy recovery must not assign a sibling");
      },
      async recordActivity() {},
      async markReleased(_sessionUuid, status, releasedAtMs, releaseReason) {
        persisted.status = status;
        persisted.released_at_ms = releasedAtMs;
        persisted.release_reason = releaseReason;
      },
    };
    sessionManager = new SessionManager(timer, persistence);
    let assignments = 0;
    const assigner: SessionDeviceAssigner = {
      async assignDeviceToSession(sessionUuid, _platform, target): Promise<string> {
        assignments += 1;
        if (!target) {
          throw new Error("persisted recovery target was not supplied");
        }
        throw new SessionRecoveryIdentityLossError(sessionUuid, target, "target-busy");
      },
    };
    const devicePool = {
      ...assigner,
      assertSessionReadyForAutomation() {},
      resolveAutolockSessionForMcpSession() {
        return undefined;
      },
      getDeviceIncarnation() {
        return 0;
      },
      bumpDeviceIncarnation() {
        return 0;
      },
    } as unknown as DevicePool;
    DaemonState.getInstance().initialize(sessionManager, devicePool);
    ToolRegistry.registerDeviceAware(
      TOOL,
      "terminal persisted recovery probe",
      z.object({
        sessionUuid: z.string(),
        platform: z.literal("android"),
      }),
      async () => {
        throw new Error("terminal session must not reach the tool handler");
      },
    );
    fixture = new McpTestFixture({ daemonMode: true });
    await fixture.setup();

    await expect(
      fixture.client.callTool({
        name: TOOL,
        arguments: { sessionUuid: SESSION_UUID, platform: "android" },
      }),
    ).rejects.toThrow(`Cannot safely recover session ${SESSION_UUID}`);
    expect(assignments).toBe(1);
    expect(persisted.release_reason).toBe("identity-recovery-target-busy");

    const second: any = await fixture.client.callTool({
      name: TOOL,
      arguments: { sessionUuid: SESSION_UUID, platform: "android" },
    });

    expect(second.isError).toBe(true);
    expect(JSON.parse(second.content[0].text)).toMatchObject({
      error: {
        code: "session_ownership_lost",
        message: TERMINAL_DIAGNOSTIC,
        sessionUuid: SESSION_UUID,
        reason: "identity-recovery-target-busy",
      },
    });
    expect(assignments).toBe(1);
  });
});
