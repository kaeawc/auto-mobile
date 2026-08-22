import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { sendSocketRequest } from "./helpers/socketRequest";
import { FeatureFlagService } from "../../src/features/featureFlags/FeatureFlagService";
import { FakeFeatureFlagRepository } from "../fakes/FakeFeatureFlagRepository";
import { FakeFeatureFlagApplier } from "../fakes/FakeFeatureFlagApplier";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DaemonResponse } from "../../src/daemon/types";
import { ListChangedBroadcaster } from "../../src/server/listChangedBroadcast";
import { ToolRegistry } from "../../src/server/toolRegistry";

function createTestService(): FeatureFlagService {
  return new FeatureFlagService(new FakeFeatureFlagRepository(), new FakeFeatureFlagApplier(), [
    { key: "debug", label: "Debug mode", description: "Enable debug tools.", defaultValue: false },
    {
      key: "ui-perf-mode",
      label: "UI perf",
      description: "Run UI perf audits.",
      defaultValue: true,
    },
  ]);
}

function createFakeDaemonState() {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({ getSession: () => null, releaseSession: async () => null }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
    }),
  };
}

function sendRequest(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<DaemonResponse> {
  return sendSocketRequest(socketPath, method, params);
}

describe("UnixSocketServer feature flag handlers", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let fakeTimer: FakeTimer;
  let featureFlagService: FeatureFlagService;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `test-ff-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    featureFlagService = createTestService();

    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
      featureFlagService,
    );
    await server.start();
  });

  afterEach(async () => {
    await server.close();
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
  });

  test("ide/listFeatureFlags returns all flags", async () => {
    const response = await sendRequest(socketPath, "ide/listFeatureFlags");

    expect(response.success).toBe(true);
    const result = response.result as {
      flags: Array<{ key: string; label: string; enabled: boolean }>;
    };
    expect(result.flags).toHaveLength(2);
    expect(result.flags[0].key).toBe("debug");
    expect(result.flags[0].enabled).toBe(false);
    expect(result.flags[1].key).toBe("ui-perf-mode");
    expect(result.flags[1].enabled).toBe(true);
  });

  test("ide/setFeatureFlag enables a flag", async () => {
    const response = await sendRequest(socketPath, "ide/setFeatureFlag", {
      key: "debug",
      enabled: true,
    });

    expect(response.success).toBe(true);
    const result = response.result as { key: string; enabled: boolean };
    expect(result.key).toBe("debug");
    expect(result.enabled).toBe(true);

    // Verify persistence
    const listResponse = await sendRequest(socketPath, "ide/listFeatureFlags");
    const listResult = listResponse.result as { flags: Array<{ key: string; enabled: boolean }> };
    const debugFlag = listResult.flags.find((f) => f.key === "debug");
    expect(debugFlag?.enabled).toBe(true);
  });

  test("ide/setFeatureFlag returns error for missing params", async () => {
    const response = await sendRequest(socketPath, "ide/setFeatureFlag", {});

    expect(response.success).toBe(false);
    expect(response.error).toContain("requires");
  });

  test("ide/setFeatureFlag returns error for unknown flag", async () => {
    const response = await sendRequest(socketPath, "ide/setFeatureFlag", {
      key: "nonexistent",
      enabled: true,
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("Unknown feature flag");
  });

  test("ide/setSessionToolEnabled persists then broadcasts a tools list refresh", async () => {
    const writes: Array<{ sessionUuid: string; toolName: string; enabled: boolean }> = [];
    const profileService = {
      setEnabled: async (sessionUuid: string, toolName: string, enabled: boolean) => {
        writes.push({ sessionUuid, toolName, enabled });
      },
    };
    ToolRegistry.register("clipboard", "clipboard", z.object({}), async () => ({ content: [] }), {
      defaultEnabled: false,
    });
    await server.close();
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
      featureFlagService,
      { sessionToolSelectionService: profileService },
    );
    await server.start();

    const emitted: string[] = [];
    const unsubscribe = ListChangedBroadcaster.subscribe((kind) => emitted.push(kind));
    try {
      const response = await sendRequest(socketPath, "ide/setSessionToolEnabled", {
        sessionUuid: "device-session-1",
        toolName: "clipboard",
        enabled: false,
      });

      expect(response.success).toBe(true);
      expect(writes).toEqual([
        {
          sessionUuid: "device-session-1",
          toolName: "clipboard",
          enabled: false,
        },
      ]);
      expect(emitted).toEqual(["tools"]);
    } finally {
      unsubscribe();
      ToolRegistry.clearTools();
    }
  });
});
