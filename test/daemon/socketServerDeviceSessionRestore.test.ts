import { InMemoryEmulatorLossIncidentStore } from "../../src/daemon/emulatorLossIncident";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DAEMON_BOUND_SESSION_PARAM } from "../../src/daemon/constants";
import { SessionToolBinding } from "../../src/server/SessionToolBinding";
import { SessionRecoveryAssignmentError } from "../../src/models/SessionRecoveryAssignmentError";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";
import { logger } from "../../src/utils/logger";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeSocket } from "../fakes/FakeNetServer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, expect, spyOn, test } from "bun:test";
import { ProgressExtendableDeadline } from "../../src/daemon/mcpRequestTimeout";
import { DaemonState } from "../../src/daemon/daemonState";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { DeviceControlTransportError } from "../../src/daemon/deviceControlTransportFailure";
import { DefaultDeviceIncarnationInvalidator } from "../../src/server/DeviceIncarnationInvalidator";
import type { DaemonRequest } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDeviceRestoreEpochHarness } from "../helpers/deviceRestoreEpochHarness";

afterEach(() => DaemonState.getInstance().reset());

test("device-control replay refuses a restore-retired epoch with actionable transport error", async () => {
  const timer = new FakeTimer();
  const device = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
  await createDeviceRestoreEpochHarness(device, timer);
  const server = new UnixSocketServer(
    "/fake/restore.sock",
    "http://localhost:0/mcp",
    DaemonState.getInstance(),
    timer,
  );
  const access = server as unknown as {
    isDeviceControlDeviceSessionValid(identity: {
      deviceId: string;
      deviceSessionUuid: string;
    }): boolean;
    deviceControlTransportError(input: {
      request: DaemonRequest;
      identity: { deviceId: string; deviceSessionUuid: string };
      phase: "response";
      reconnectAttempted: boolean;
      replayAttempted: boolean;
      recoveryExhausted: boolean;
    }): DeviceControlTransportError;
  };
  const identity = { deviceId: device.deviceId, deviceSessionUuid: "epoch-old" };
  expect(access.isDeviceControlDeviceSessionValid(identity)).toBe(true);
  await new DefaultDeviceIncarnationInvalidator([]).invalidate(device);
  expect(access.isDeviceControlDeviceSessionValid(identity)).toBe(false);
  const error = access.deviceControlTransportError({
    request: {
      id: "restore",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "observe", arguments: {} },
    },
    identity,
    phase: "response",
    reconnectAttempted: true,
    replayAttempted: false,
    recoveryExhausted: false,
  });
  expect(error).toBeInstanceOf(DeviceControlTransportError);
  expect(error.failure).toMatchObject({ deviceSessionValid: false, retryable: false });
  expect(error.message).toContain("snapshot restore");
  expect(error.message).toContain("deviceSnapshot");
});

// Exercise the socket gates with the real persisted-session/pool recovery path,
// substituting only the loopback transport and device discovery.
async function boundRecoveryHarness() {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const manager = new SessionManager(timer, persistence);
  manager.stopCleanupTimer();
  const incidents = new InMemoryEmulatorLossIncidentStore(timer);
  const incident = await incidents.open({
    deviceId: "emulator-5554",
    avdName: "Pixel",
    detectionPath: "watched-process-exit",
    recoveryPolicy: { onLoss: false, maxAttempts: 1 },
    session: {
      sessionUuid: "bound",
      state: "recovering",
      lastHeartbeatMs: 0,
      hasReceivedHeartbeat: false,
      heartbeatTimeoutMs: 60_000,
    },
  });
  await incidents.completeRecovery(incident.id, "not-attempted");
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "test-daemon", {
      timer,
      deviceManager: new FakeDeviceManager(),
      installedAppsRepository: new FakeInstalledAppsRepository(),
      emulatorLossIncidentStore: incidents,
    }),
  );
  const server = new UnixSocketServer(
    "/fake/recovery.sock",
    "http://localhost:0/mcp",
    {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => pool,
      getDeviceSessionRegistry: () => ({ list: () => [] }),
    },
    timer,
  );
  server["acceptingRequests"] = true;
  const socket = new FakeSocket();
  server["handleConnection"](socket);
  const socketId = [...server["sessions"].keys()][0]!;
  const forwarded: Record<string, unknown>[] = [];
  const recoveryErrors: unknown[] = [];
  const discoverySeeds: { method: string; sessionUuid: string | undefined }[] = [];
  server.mcpClientFactory = async (seed) => {
    const binding = new SessionToolBinding(seed);
    return {
      callTool: async ({ arguments: args }) => {
        forwarded.push(args ?? {});
        const sessionUuid = binding.effectiveSessionUuid("loopback", args)!;
        try {
          await manager.admitIssuedSessionForAutomation(sessionUuid);
          await manager.getOrCreateSession(sessionUuid, pool, "android", undefined, true);
          return { content: [] };
        } catch (error) {
          recoveryErrors.push(error);
          return shapeToolCallError(error, { toolName: "observe", source: "MCP" });
        }
      },
      listTools: async () => {
        discoverySeeds.push({ method: "tools/list", sessionUuid: seed });
        return { tools: [] };
      },
      listResources: async () => {
        discoverySeeds.push({ method: "resources/list", sessionUuid: seed });
        return { resources: [] };
      },
      readResource: async () => {
        discoverySeeds.push({ method: "resources/read", sessionUuid: seed });
        return { contents: [] };
      },
      listResourceTemplates: async () => {
        discoverySeeds.push({ method: "resources/list-templates", sessionUuid: seed });
        return { resourceTemplates: [] };
      },
      close: async () => {},
    };
  };
  await manager.createSession("bound", "emulator-5554", "android", undefined, undefined, "Pixel");
  const call = (
    bound = true,
    sessionUuid = "bound",
    connectionId = socketId,
    connectionSocket = socket,
  ) =>
    server["handleRequest"](connectionId, connectionSocket, {
      id: "recovery",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "observe",
        arguments: {
          sessionUuid,
          ...(bound ? { [DAEMON_BOUND_SESSION_PARAM]: sessionUuid } : {}),
        },
      },
    });
  await call(false);
  return {
    timer,
    persistence,
    manager,
    server,
    socketId,
    forwarded,
    recoveryErrors,
    discoverySeeds,
    call,
    request: (method: string) =>
      server["handleRequest"](socketId, socket, {
        id: method,
        type: "mcp_request",
        method,
        params: {
          sessionUuid: "bound",
          [DAEMON_BOUND_SESSION_PARAM]: "bound",
          uri: "automobile:devices",
        },
      }),
    connect: () => {
      const other = new FakeSocket();
      server["handleConnection"](other);
      const id = [...server["sessions"].keys()].at(-1)!;
      return { id, socket: other };
    },
    close: () => {
      socket.destroy();
      manager.stopCleanupTimer();
    },
  };
}

test("bound call inside restart window reaches session_recovery_pending and keeps binding", async () => {
  const h = await boundRecoveryHarness();
  try {
    await h.manager.releaseSession("bound", "device-restart:Pixel");
    const response = await h.call();
    expect(response).toMatchObject({ success: true, result: { isError: true } });
    expect(response?.boundSessionLoss).toBeUndefined();
    expect(h.recoveryErrors.at(-1)).toBeInstanceOf(SessionRecoveryAssignmentError);
    const pending = shapeToolCallError(h.recoveryErrors.at(-1), {
      toolName: "observe",
      source: "MCP",
    });
    expect(response?.result).toEqual(pending);
    expect(JSON.parse(pending.content[0].text).error).toMatchObject({
      code: "session_recovery_pending",
      retryable: true,
      recoveryWindowRemainingMs: 180_000,
    });
    expect(h.server["boundMcpClientKeysBySocketSession"].get(h.socketId)?.sessionUuid).toBe(
      "bound",
    );
    expect(h.forwarded.at(-1)?.sessionUuid).toBeUndefined();
    const bindingBeforeExplicit = h.server["boundMcpClientKeysBySocketSession"].get(h.socketId);
    const explicit = await h.call(false);
    expect(explicit?.result).toEqual(response?.result);
    const explicitBinding = h.server["boundMcpClientKeysBySocketSession"].get(h.socketId);
    expect(explicitBinding).toEqual({
      ...bindingBeforeExplicit,
      executionKey: "session:bound",
      requiresLiveDaemonSession: false,
    });
    expect((await h.call())?.result).toEqual(response?.result);
    expect(h.server["boundMcpClientKeysBySocketSession"].get(h.socketId)).toEqual(explicitBinding);
  } finally {
    h.close();
  }
});

test.each(["explicit-release", "heartbeat-timeout", "superseded", "device-killed"])(
  "bound call with %s keeps today's loss reason and fencing",
  async (reason) => {
    const h = await boundRecoveryHarness();
    try {
      await h.manager.releaseSession("bound", reason);
      const response = await h.call();
      expect(response).toMatchObject({
        success: false,
        boundSessionLoss: {
          code: "bound_session_lost",
          sessionUuid: "bound",
          reason: reason === "superseded" ? "session-not-found" : reason,
        },
      });
      expect(h.forwarded).toHaveLength(1);
    } finally {
      h.close();
    }
  },
);

test.each(["expired", "no-row", "query-failure"])(
  "bound call fails closed for %s",
  async (failure) => {
    const h = await boundRecoveryHarness();
    const warn = spyOn(logger, "warn");
    try {
      await h.manager.releaseSession("bound", "device-restart:Pixel");
      if (failure === "expired") {
        h.timer.advanceTime(180_000);
      }
      if (failure === "no-row") {
        h.persistence.getSession = async () => undefined;
      }
      if (failure === "query-failure") {
        h.persistence.getSession = async () => {
          throw new Error("row read failed");
        };
      }
      const response = await h.call();
      expect(response).toMatchObject({
        success: false,
        boundSessionLoss: {
          code: "bound_session_lost",
          sessionUuid: "bound",
          reason: "session-not-found",
        },
      });
      expect(h.forwarded).toHaveLength(1);
      if (failure === "query-failure") {
        expect(
          warn.mock.calls.some(([message]) => String(message).includes("row read failed")),
        ).toBe(true);
      }
    } finally {
      warn.mockRestore();
      h.close();
    }
  },
);

test("healthy bound route is synchronous and does not read persistence", async () => {
  const h = await boundRecoveryHarness();
  try {
    const lookup = spyOn(h.persistence, "getSession");
    const route = h.server["getMcpForwardRoute"](
      {
        id: "healthy",
        type: "mcp_request",
        method: "tools/call",
        params: {
          name: "observe",
          arguments: { sessionUuid: "bound", [DAEMON_BOUND_SESSION_PARAM]: "bound" },
        },
      },
      h.socketId,
    );
    expect(route).not.toBeInstanceOf(Promise);
    const client = await h.server["getMcpClient"](route.clientKey, "bound");
    const before = h.forwarded.length;
    const forward = h.server["handleIdeRequest"](
      client,
      {
        id: "healthy",
        type: "mcp_request",
        method: "tools/call",
        params: {
          name: "observe",
          arguments: { sessionUuid: "bound", [DAEMON_BOUND_SESSION_PARAM]: "bound" },
        },
      },
      1_000,
      h.socketId,
      new ProgressExtendableDeadline(h.timer.now(), 1_000),
      1_000,
    );
    expect(h.forwarded).toHaveLength(before + 1);
    await forward;
    expect(lookup).not.toHaveBeenCalled();
    expect(await h.call()).toMatchObject({ success: true });
    expect(lookup).not.toHaveBeenCalled();
  } finally {
    h.close();
  }
});

test("explicit restart recovery bypasses the bound-session probe", async () => {
  const h = await boundRecoveryHarness();
  try {
    await h.manager.releaseSession("bound", "device-restart:Pixel");
    const probe = spyOn(h.manager, "isReleasedSessionInRestartRecoveryWindow");
    const response = await h.call(false);
    expect(response).toMatchObject({ success: true, result: { isError: true } });
    expect(h.recoveryErrors.at(-1)).toBeInstanceOf(SessionRecoveryAssignmentError);
    expect(probe).not.toHaveBeenCalled();
  } finally {
    h.close();
  }
});

test("never-issued bound identity retains ReleasedBoundSessionError and loss fencing", async () => {
  const h = await boundRecoveryHarness();
  try {
    const args = { sessionUuid: "never-issued", [DAEMON_BOUND_SESSION_PARAM]: "never-issued" };
    const error = await Promise.resolve()
      .then(() => h.server["getToolsCallForwardRoute"](args, h.socketId, "observe"))
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      name: "ReleasedBoundSessionError",
      failure: {
        code: "bound_session_lost",
        sessionUuid: "never-issued",
        reason: "session-not-found",
      },
    });
    expect(await h.call(true, "never-issued")).toMatchObject({
      success: false,
      boundSessionLoss: {
        code: "bound_session_lost",
        sessionUuid: "never-issued",
        reason: "session-not-found",
      },
    });
    expect(h.forwarded).toHaveLength(1);
  } finally {
    h.close();
  }
});

test.each(["tools/list", "resources/list", "resources/list-templates", "resources/read"])(
  "%s serves the recovering session without dropping its binding and fences after expiry",
  async (method) => {
    const h = await boundRecoveryHarness();
    try {
      const binding = h.server["boundMcpClientKeysBySocketSession"].get(h.socketId);
      await h.manager.releaseSession("bound", "device-restart:Pixel");
      expect(await h.request(method)).toMatchObject({ success: true });
      expect(h.discoverySeeds.at(-1)).toEqual({ method, sessionUuid: "bound" });
      expect(h.server["boundMcpClientKeysBySocketSession"].get(h.socketId)).toEqual(binding);
      expect((await h.call())?.boundSessionLoss).toBeUndefined();
      h.timer.advanceTime(180_000);
      expect(await h.request(method)).toMatchObject({
        success: false,
        boundSessionLoss: {
          sessionUuid: "bound",
          reason: "session-not-found",
        },
      });
      expect(h.discoverySeeds).toHaveLength(1);
    } finally {
      h.close();
    }
  },
);

test.each(["explicit-release", "heartbeat-timeout", "superseded", "device-killed"])(
  "terminal %s revokes restart recovery for bound and explicit calls",
  async (reason) => {
    const h = await boundRecoveryHarness();
    try {
      await h.manager.releaseSession("bound", "device-restart:Pixel");
      await h.manager.releaseSession("bound", reason);
      expect(await h.manager.isReleasedSessionInRestartRecoveryWindow("bound")).toBe(false);
      expect(await h.call()).toMatchObject({
        success: false,
        boundSessionLoss: { sessionUuid: "bound" },
      });
      const explicit = await h.call(false);
      expect(explicit).toMatchObject({ success: true, result: { isError: true } });
      expect(h.recoveryErrors.at(-1)).not.toBeInstanceOf(SessionRecoveryAssignmentError);
      expect(h.manager.getSession("bound")).toBeNull();
      expect(await h.call()).toMatchObject({
        success: false,
        boundSessionLoss: { sessionUuid: "bound" },
      });
    } finally {
      h.close();
    }
  },
);

test("a second connection's recovery marker grants only explicit-path results and no binding", async () => {
  const h = await boundRecoveryHarness();
  const other = h.connect();
  try {
    await h.manager.releaseSession("bound", "device-restart:Pixel");
    const marked = await h.call(true, "bound", other.id, other.socket);
    expect(h.server["boundMcpClientKeysBySocketSession"].get(other.id)).toBeUndefined();
    const explicit = await h.call(false, "bound", other.id, other.socket);
    expect(marked?.result).toEqual(explicit?.result);
    expect(h.manager.getSession("bound")).toBeNull();
    expect(h.server["boundMcpClientKeysBySocketSession"].get(h.socketId)?.sessionUuid).toBe(
      "bound",
    );
  } finally {
    other.socket.destroy();
    h.close();
  }
});

test.each(["active", "recovering"])("session lookup throws fail closed while %s", async (state) => {
  const h = await boundRecoveryHarness();
  const warn = spyOn(logger, "warn");
  try {
    if (state === "recovering") {
      await h.manager.releaseSession("bound", "device-restart:Pixel");
    }
    const lookup = spyOn(h.manager, "getSession").mockImplementation(() => {
      throw new Error("state read failed");
    });
    try {
      expect(await h.call()).toMatchObject({
        success: false,
        boundSessionLoss: { sessionUuid: "bound" },
      });
      expect(h.forwarded).toHaveLength(1);
      expect(
        warn.mock.calls.some(([message]) => String(message).includes("state read failed")),
      ).toBe(true);
    } finally {
      lookup.mockRestore();
    }
  } finally {
    warn.mockRestore();
    h.close();
  }
});

test.each(["expiry", "stale-true", "probe-throw"])(
  "%s between recovery probes is fenced before forwarding",
  async (race) => {
    const h = await boundRecoveryHarness();
    const warn = spyOn(logger, "warn");
    try {
      await h.manager.releaseSession("bound", "device-restart:Pixel");
      const original = h.manager.isReleasedSessionInRestartRecoveryWindow.bind(h.manager);
      let probes = 0;
      const probe = spyOn(h.manager, "isReleasedSessionInRestartRecoveryWindow").mockImplementation(
        async (uuid) => {
          probes++;
          if (probes === 1) {
            const result = await original(uuid);
            if (race === "expiry") {
              h.timer.advanceTime(180_000);
            }
            if (race === "stale-true") {
              h.persistence.getSession = async () => undefined;
            }
            return result;
          }
          if (race === "probe-throw") {
            throw new Error("probe read failed");
          }
          return original(uuid);
        },
      );
      try {
        expect(await h.call()).toMatchObject({
          success: false,
          boundSessionLoss: { sessionUuid: "bound", reason: "session-not-found" },
        });
        expect(probes).toBeGreaterThanOrEqual(2);
        expect(h.forwarded).toHaveLength(1);
        if (race === "probe-throw") {
          expect(
            warn.mock.calls.some(([message]) => String(message).includes("probe read failed")),
          ).toBe(true);
        }
      } finally {
        probe.mockRestore();
      }
    } finally {
      warn.mockRestore();
      h.close();
    }
  },
);
