import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import {
  DAEMON_SHUTTING_DOWN_ERROR_CODE,
  DAEMON_SHUTTING_DOWN_ERROR_MESSAGE,
} from "../../src/daemon/constants";
import { isDaemonShuttingDownToolResult } from "../../src/daemon/daemonShutdownOutcome";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { DeviceSessionPersistence } from "../../src/db/deviceSessionRepository";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { serverConfig } from "../../src/utils/ServerConfig";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";

const NO_SCHEMA_TOOL_NAME = "__daemon_shutdown_wire_no_schema_probe__";
const SCHEMA_TOOL_NAME = "__daemon_shutdown_wire_schema_probe__";

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
    const handler = async () => {
      if (!sessionManager) {
        throw new Error("SessionManager must be initialized before the wire probe runs");
      }
      return await sessionManager.createSession("pending-ios-session", "ios-simulator-a", "ios");
    };
    ToolRegistry.register(
      NO_SCHEMA_TOOL_NAME,
      "daemon shutdown wire probe without output schema",
      z.object({}),
      handler,
    );
    ToolRegistry.register(
      SCHEMA_TOOL_NAME,
      "daemon shutdown wire probe with output schema",
      z.object({}),
      handler,
      {
        outputSchema: z.object({
          id: z.string(),
          deviceId: z.string(),
          platform: z.string(),
        }),
      },
    );
    await fixture.setup();
  });

  afterAll(async () => {
    await fixture.teardown();
    ToolRegistry.unregister(NO_SCHEMA_TOOL_NAME);
    ToolRegistry.unregister(SCHEMA_TOOL_NAME);
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
  });

  for (const { name, suppressStructuredContent, reason } of [
    {
      name: NO_SCHEMA_TOOL_NAME,
      suppressStructuredContent: false,
      reason: "the tool has no output schema",
    },
    {
      name: SCHEMA_TOOL_NAME,
      suppressStructuredContent: true,
      reason: "structured-content suppression is enabled",
    },
  ]) {
    test(`omits structuredContent when a session creation loses the shutdown race and ${reason}`, async () => {
      const persistence = new DeferredSessionPersistence();
      sessionManager = new SessionManager(new FakeTimer(), persistence);
      serverConfig.setToolResultsNoStructuredContentEnabled(suppressStructuredContent);
      try {
        const pending = fixture.client.callTool({ name, arguments: {} });
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
          isError: true,
        });
        expect("structuredContent" in result).toBe(false);
        expect(sessionManager.getSession("pending-ios-session")).toBeNull();
      } finally {
        persistence.finishUpsert();
        sessionManager.stopCleanupTimer();
        sessionManager = undefined;
        serverConfig.setToolResultsNoStructuredContentEnabled(false);
      }
    });
  }

  test("preserves the shutdown marker for the private daemon loopback", async () => {
    const daemonFixture = new McpTestFixture({ daemonMode: true });
    const persistence = new DeferredSessionPersistence();
    sessionManager = new SessionManager(new FakeTimer(), persistence);
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    try {
      await daemonFixture.setup();
      const pending = daemonFixture.client.callTool({ name: NO_SCHEMA_TOOL_NAME, arguments: {} });
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
      expect(isDaemonShuttingDownToolResult(result)).toBe(true);
      expect(sessionManager.getSession("pending-ios-session")).toBeNull();
    } finally {
      persistence.finishUpsert();
      sessionManager.stopCleanupTimer();
      sessionManager = undefined;
      serverConfig.setToolResultsNoStructuredContentEnabled(false);
      await daemonFixture.teardown();
    }
  });
});
