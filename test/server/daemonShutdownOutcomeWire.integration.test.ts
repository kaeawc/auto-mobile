import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import {
  DAEMON_SHUTTING_DOWN_ERROR_CODE,
  DAEMON_SHUTTING_DOWN_ERROR_MESSAGE,
} from "../../src/daemon/constants";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { DeviceSessionPersistence } from "../../src/db/deviceSessionRepository";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";

const TOOL_NAME = "__daemon_shutdown_wire_probe__";

class DeferredSessionPersistence implements DeviceSessionPersistence {
  private readonly upsertStarted = Promise.withResolvers<void>();
  private readonly allowUpsert = Promise.withResolvers<void>();

  async upsertActiveSession(): Promise<void> {
    this.upsertStarted.resolve();
    await this.allowUpsert.promise;
  }

  async recordActivity(): Promise<void> {}

  async markReleased(): Promise<void> {}

  async waitForUpsert(): Promise<void> {
    await this.upsertStarted.promise;
  }

  finishUpsert(): void {
    this.allowUpsert.resolve();
  }
}

describe("daemon shutdown MCP outcome", () => {
  const fixture = new McpTestFixture();
  let sessionManager: SessionManager | undefined;

  beforeAll(async () => {
    ToolRegistry.register(TOOL_NAME, "daemon shutdown wire probe", z.object({}), async () => {
      if (!sessionManager) {
        throw new Error("SessionManager must be initialized before the wire probe runs");
      }
      return await sessionManager.createSession("pending-ios-session", "ios-simulator-a", "ios");
    });
    await fixture.setup();
  });

  afterAll(async () => {
    await fixture.teardown();
    ToolRegistry.unregister(TOOL_NAME);
  });

  test("returns a structured retryable outcome when a session creation loses the shutdown race", async () => {
    const persistence = new DeferredSessionPersistence();
    sessionManager = new SessionManager(new FakeTimer(), persistence);
    try {
      const pending = fixture.client.callTool({ name: TOOL_NAME, arguments: {} });
      await persistence.waitForUpsert();
      sessionManager.stopAcceptingSessionCreations();
      persistence.finishUpsert();

      const result = await pending;
      const expected = {
        error: {
          code: DAEMON_SHUTTING_DOWN_ERROR_CODE,
          message: DAEMON_SHUTTING_DOWN_ERROR_MESSAGE,
          retryable: true,
        },
      };

      expect(result).toMatchObject({
        content: [{ type: "text", text: JSON.stringify(expected) }],
        structuredContent: expected,
        isError: true,
      });
      expect(sessionManager.getSession("pending-ios-session")).toBeNull();
    } finally {
      persistence.finishUpsert();
      sessionManager.stopCleanupTimer();
      sessionManager = undefined;
    }
  });
});
