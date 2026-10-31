import { toolText } from "../helpers/toolResponse";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { afterEach, describe, expect, test, beforeAll, afterAll } from "bun:test";
import { z } from "zod/v4";
import type { DeviceSessionPersistence } from "../../src/db/deviceSessionRepository";
import type { DeviceSession } from "../../src/db/types";
import { DevicePool } from "../../src/daemon/devicePool";
import type { Platform } from "../../src/models";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { DaemonState } from "../../src/daemon/daemonState";
import {
  SessionManager,
  SessionRecoveryIdentityLossError,
  type SessionRecoveryTarget,
} from "../../src/daemon/sessionManager";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { FakeTimer } from "../fakes/FakeTimer";

const TOOL = "__terminal_persisted_recovery_probe__";
const SESSION_UUID = "persisted-target-busy-session";
const TERMINAL_DIAGNOSTIC =
  `Session ${SESSION_UUID} is terminal after identity-recovery-target-busy and cannot be reused. ` +
  "Acquire a new device with getAndroid or getApple.";

/** A real pool whose recovery assignment is always refused as target-busy. */
class TargetBusyDevicePool extends DevicePool {
  assignments = 0;

  override async assignDeviceToSession(
    sessionUuid: string,
    _platform?: Platform,
    target?: SessionRecoveryTarget,
  ): Promise<string> {
    this.assignments += 1;
    if (!target) {
      throw new Error("persisted recovery target was not supplied");
    }
    throw new SessionRecoveryIdentityLossError(sessionUuid, target, "target-busy");
  }

  override assertSessionReadyForAutomation(): void {}

  override resolveAutolockSessionForMcpSession(): string | undefined {
    return undefined;
  }

  override isSessionOwnedByOtherConnection(): boolean {
    return false;
  }

  override getDeviceIncarnation(): number | undefined {
    return 0;
  }

  override bumpDeviceIncarnation(): boolean {
    return false;
  }
}

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
      stable_identity_generation: 0,
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
      activity_seq: 0,
      heartbeat_timeout_source: null,
      liveness_contract_generation: 0,
      liveness_owner_token: null,
      liveness_policy: null,
      pre_cli_heartbeat_timeout_ms: null,
      pre_cli_heartbeat_timeout_source: null,
      pre_cli_session_timeout_ms: null,
      created_at: "2026-09-15T00:00:00.000Z",
      updated_at: "2026-09-15T00:00:00.000Z",
    };
    const persistence: DeviceSessionPersistence = Object.assign(
      new FakeDeviceSessionPersistence(),
      {
        recordLivenessOwnership: async () => {},
        replaceLivenessOwnership: async () => {},
        claimRecoverableSession: async (_id, expected) => expected.rowGeneration,
        async getSession() {
          return persisted;
        },
        async upsertActiveSession() {
          throw new Error("target-busy recovery must not assign a sibling");
        },
        async recordActivity() {},
        async markReleased(_sessionUuid, status, releasedAtMs, { reason: releaseReason }) {
          persisted.status = status;
          persisted.released_at_ms = releasedAtMs;
          persisted.release_reason = releaseReason;
        },
      } satisfies Partial<DeviceSessionPersistence> & Record<string, unknown>,
    );
    sessionManager = new SessionManager(timer, persistence);
    const devicePool = new TargetBusyDevicePool(
      createDevicePoolDependencies(sessionManager, "terminal-persisted-recovery", {
        timer,
        deviceManager: new FakeDeviceUtils(),
      }),
    );
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

    const blockedRecovery = await fixture.client.callTool({
      name: TOOL,
      arguments: { sessionUuid: SESSION_UUID, platform: "android" },
    });
    expect(blockedRecovery).toMatchObject({ isError: true });
    expect(toolText(blockedRecovery)).toContain(`Cannot safely recover session ${SESSION_UUID}`);
    expect(devicePool.assignments).toBe(1);
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
        retryable: false,
        nextAction: "acquire_new_session",
      },
    });
    expect(devicePool.assignments).toBe(1);
  });
});

// App-resource registration starts device discovery independently of deviceTools.
let restoreHermeticServer: () => void;
beforeAll(() => {
  restoreHermeticServer = installHermeticServerFixture();
});
afterAll(() => restoreHermeticServer());
