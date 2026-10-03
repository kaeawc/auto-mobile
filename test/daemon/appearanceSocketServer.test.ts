import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Socket } from "node:net";
import {
  AppearanceSocketServer,
  type AppearanceDeviceSource,
  type AppearanceSocketServerDependencies,
} from "../../src/daemon/appearanceSocketServer";
import { AppearanceSocketResponse } from "../../src/daemon/appearanceSocketTypes";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeSocket } from "../fakes/FakeNetServer";
import {
  SessionScopedStreamAuthenticator,
  STREAM_SOCKET_AUTH_ENV,
  type StreamAuthSessionManager,
  type StreamSocketAuthenticator,
} from "../../src/daemon/streamSocketAuth";
import { type AppearanceConfig, type BootedDevice } from "../../src/models";

/**
 * Drives requests through the real inherited processLine dispatch (queue +
 * handleLine + handleRequest) against only in-memory dependencies.
 */
const allowAllAuthenticator: StreamSocketAuthenticator = { authorize: () => {} };
const emptyDeviceSource: AppearanceDeviceSource = {
  getPooledDevices: () => [],
  getCurrentDevice: () => undefined,
  getSessionForDevice: () => null,
};
const initialConfig: AppearanceConfig = {
  syncWithHost: false,
  defaultMode: "light",
  applyOnConnect: true,
};

function fakeDependencies(applied: string[] = []): AppearanceSocketServerDependencies {
  let config = { ...initialConfig };
  return {
    getConfig: async () => config,
    updateConfig: async (update) => {
      config = { ...config, ...update } as AppearanceConfig;
      return config;
    },
    resolveMode: async () => "light",
    applyToDevice: async (device, mode) => {
      applied.push(`${device.deviceId}:${mode}`);
    },
    triggerSync: async () => {},
    isSyncEnabled: () => true,
  };
}

function sessionManager(): StreamAuthSessionManager {
  return {
    getSession: (sessionUuid) => (sessionUuid === "live" ? {} : null),
    getSessionForDevice: () => null,
    getDeviceLabels: () => undefined,
  };
}

function ownedDeviceSource({
  manager,
  pooled,
  current,
}: {
  manager: StreamAuthSessionManager;
  pooled: string[];
  current?: string;
}): AppearanceDeviceSource {
  return {
    getPooledDevices: () => pooled.map(device),
    getCurrentDevice: () => (current ? device(current) : undefined),
    getSessionForDevice: (deviceId) => manager.getSessionForDevice(deviceId),
  };
}

function ownershipManager(): StreamAuthSessionManager {
  const owners = new Map([
    ["own", "live"],
    ["label-owned", "live:phone"],
    ["other", "different"],
    ["hung", "live"],
    ["ready", "live"],
  ]);
  return {
    getSession: (uuid) => (["live", "different", "no-device"].includes(uuid) ? {} : null),
    getSessionForDevice: (deviceId) => owners.get(deviceId) ?? null,
    getDeviceLabels: (uuid) => (uuid === "live" ? { phone: "live:phone" } : undefined),
  };
}

function device(deviceId: string): BootedDevice {
  return { deviceId, name: deviceId, platform: "android" } as BootedDevice;
}

class TestableAppearanceSocketServer extends AppearanceSocketServer {
  constructor(
    timer: FakeTimer,
    authenticator: StreamSocketAuthenticator = allowAllAuthenticator,
    deviceSource: AppearanceDeviceSource = emptyDeviceSource,
    dependencies: AppearanceSocketServerDependencies = fakeDependencies(),
  ) {
    super("/fake/path/appearance.sock", timer, authenticator, deviceSource, dependencies);
  }

  async startFake(): Promise<void> {
    (this as any).server = { listening: true };
  }

  async simulateLine(socket: FakeSocket, line: string): Promise<void> {
    await (this as any).processLine(socket as unknown as Socket, line);
    const pending = (this as any).pendingBySocket.get(socket);
    if (pending) {
      await pending;
    }
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

describe("AppearanceSocketServer", () => {
  let server: TestableAppearanceSocketServer;
  let timer: FakeTimer;
  let socket: FakeSocket;

  beforeEach(async () => {
    timer = new FakeTimer();
    server = new TestableAppearanceSocketServer(timer);
    await server.startFake();
    socket = new FakeSocket();
  });

  for (const { enabled, syncEnabled } of [
    { enabled: true, syncEnabled: false },
    { enabled: true, syncEnabled: true },
    { enabled: false, syncEnabled: false },
    { enabled: false, syncEnabled: true },
  ]) {
    it(`set_appearance_sync(${enabled}) reports the automatic sync decision (${syncEnabled})`, async () => {
      const applied: string[] = [];
      const dependencies = fakeDependencies(applied);
      dependencies.isSyncEnabled = () => syncEnabled;
      let syncs = 0;
      dependencies.triggerSync = async () => {
        syncs++;
      };
      server = new TestableAppearanceSocketServer(
        timer,
        { authorize: () => {}, isAuthenticationEnforced: () => false },
        { ...emptyDeviceSource, getPooledDevices: () => [device("own")] },
        dependencies,
      );
      await server.startFake();
      await server.simulateLine(
        socket,
        JSON.stringify({ id: "sync-hint", command: "set_appearance_sync", params: { enabled } }),
      );
      const response = socket.getWrittenMessages<AppearanceSocketResponse>()[0];
      expect(response.success).toBe(true);
      expect(response.result?.config?.syncWithHost).toBe(enabled);
      expect(response.result?.appliedMode).toBe("light");
      expect(applied).toEqual(["own:light"]);
      expect(syncs).toBe(1);
      if (enabled && !syncEnabled) {
        expect(response.result?.warning).toBe(
          "Automatic appearance sync is disabled by AUTOMOBILE_APPEARANCE_SYNC.",
        );
      } else {
        expect(response.result).not.toHaveProperty("warning");
      }
    });
  }

  describe("targeted request-chain bypass", () => {
    let applyGate: ReturnType<typeof Promise.withResolvers<void>>;
    let configGate: ReturnType<typeof Promise.withResolvers<AppearanceConfig>> | undefined;
    let dependencies: AppearanceSocketServerDependencies;
    let applied: string[];
    let updates: number;
    let pendingRequests: Promise<void>[];

    beforeEach(async () => {
      applyGate = Promise.withResolvers<void>();
      configGate = undefined;
      applied = [];
      updates = 0;
      pendingRequests = [];
      dependencies = fakeDependencies();
      const updateConfig = dependencies.updateConfig;
      dependencies.updateConfig = async (update) => {
        updates++;
        return updateConfig(update);
      };
      dependencies.applyToDevice = async (target, mode) => {
        applied.push(`${target.deviceId}:${mode}`);
        await applyGate.promise;
      };
      const manager = ownershipManager();
      server = new TestableAppearanceSocketServer(
        timer,
        new SessionScopedStreamAuthenticator(() => manager, "appearance", {}),
        ownedDeviceSource({ manager, pooled: ["own"] }),
        dependencies,
      );
      await server.startFake();
      // simulateLine awaits the chain, so retain its promise while the set is gated.
      pendingRequests.push(
        server.simulateLine(
          socket,
          JSON.stringify({
            id: "set",
            command: "set_appearance",
            sessionUuid: "live",
            mode: "dark",
          }),
        ),
      );
      await flushMicrotasks();
      expect(applied).toEqual(["own:dark"]);
      expect(socket.getWrittenMessages()).toEqual([]);
    });

    afterEach(async () => {
      // Release gates even after a failed assertion, including during the unfixed run.
      configGate?.resolve(initialConfig);
      applyGate.resolve();
      await Promise.all(pendingRequests);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });

    for (const field of ["command", "method"] as const) {
      it(`answers get_appearance_config via ${field} before an in-flight set completes`, async () => {
        pendingRequests.push(
          server.simulateLine(
            socket,
            JSON.stringify({ id: "read", [field]: "get_appearance_config" }),
          ),
        );
        await flushMicrotasks();
        expect(socket.getWrittenMessages<AppearanceSocketResponse>()).toEqual([
          {
            id: "read",
            type: "appearance_response",
            success: true,
            result: { config: { ...initialConfig, defaultMode: "dark" } },
          },
        ]);
        expect(applied).toEqual(["own:dark"]);

        applyGate.resolve();
        await Promise.all(pendingRequests);
        expect(socket.getWrittenMessages<AppearanceSocketResponse>().map(({ id }) => id)).toEqual([
          "read",
          "set",
        ]);
        expect(socket.getWrittenMessages<AppearanceSocketResponse>()[1].success).toBe(true);
      });
    }

    for (const command of ["set_appearance", "set_appearance_sync"] as const) {
      it(`keeps ${command} ordered behind an in-flight set_appearance`, async () => {
        pendingRequests.push(
          server.simulateLine(
            socket,
            JSON.stringify({
              id: "second",
              command,
              sessionUuid: "live",
              mode: "light",
              enabled: true,
            }),
          ),
        );
        await flushMicrotasks();
        expect(updates).toBe(1);
        expect(applied).toEqual(["own:dark"]);
        expect(socket.getWrittenMessages()).toEqual([]);

        applyGate.resolve();
        await Promise.all(pendingRequests);
        expect(updates).toBe(2);
        expect(applied).toEqual(["own:dark", "own:light"]);
        expect(
          socket
            .getWrittenMessages<AppearanceSocketResponse>()
            .map(({ id, success }) => ({ id, success })),
        ).toEqual([
          { id: "set", success: true },
          { id: "second", success: true },
        ]);
      });
    }

    it("returns a bypass handler error with the read request id while a set is in flight", async () => {
      dependencies.getConfig = async () => {
        throw new Error("config unavailable");
      };
      pendingRequests.push(
        server.simulateLine(
          socket,
          JSON.stringify({ id: "failed-read", command: "get_appearance_config" }),
        ),
      );
      await flushMicrotasks();
      expect(socket.getWrittenMessages<AppearanceSocketResponse>()).toEqual([
        {
          id: "failed-read",
          type: "appearance_response",
          success: false,
          error: "config unavailable",
        },
      ]);
    });

    it("does not write when a socket is destroyed during a bypassed get_appearance_config", async () => {
      configGate = Promise.withResolvers<AppearanceConfig>();
      const gate = configGate;
      let readStarted = false;
      dependencies.getConfig = () => {
        readStarted = true;
        return gate.promise;
      };
      pendingRequests.push(
        server.simulateLine(
          socket,
          JSON.stringify({ id: "destroyed-read", command: "get_appearance_config" }),
        ),
      );
      await flushMicrotasks();
      expect(readStarted).toBe(true);
      socket.destroy();
      configGate.resolve(initialConfig);
      await flushMicrotasks();
      expect(socket.getWrittenData()).toEqual([]);

      applyGate.resolve();
      await expect(Promise.all(pendingRequests)).resolves.toEqual([undefined, undefined]);
      expect(socket.getWrittenData()).toEqual([]);
    });

    for (const request of [
      { command: "bogus" },
      {},
      { command: "bogus", method: "get_appearance_config" },
    ]) {
      it(`keeps unsupported request ${JSON.stringify(request)} in the chain`, async () => {
        pendingRequests.push(
          server.simulateLine(socket, JSON.stringify({ id: "unsupported", ...request })),
        );
        await flushMicrotasks();
        expect(socket.getWrittenMessages()).toEqual([]);

        applyGate.resolve();
        await Promise.all(pendingRequests);
        expect(socket.getWrittenMessages<AppearanceSocketResponse>()).toEqual([
          expect.objectContaining({ id: "set", success: true }),
          {
            id: "unsupported",
            type: "appearance_response",
            success: false,
            error: `Unsupported appearance command: ${request.command}`,
          },
        ]);
      });
    }
  });

  it("continues after a hung target's deadline and returns the applied mode", async () => {
    const applied: string[] = [];
    let triggered = false;
    const dependencies = fakeDependencies();
    dependencies.applyDeadlineMs = 25;
    dependencies.applyToDevice = async (target, mode) => {
      applied.push(`${target.deviceId}:${mode}`);
      if (target.deviceId === "hung") {
        await new Promise<void>(() => {});
      }
    };
    dependencies.triggerSync = async () => {
      triggered = true;
    };
    const manager = ownershipManager();
    const source = ownedDeviceSource({ manager, pooled: ["hung", "ready", "unowned"] });
    const auth = new SessionScopedStreamAuthenticator(() => manager, "appearance", {});
    server = new TestableAppearanceSocketServer(timer, auth, source, dependencies);
    await server.startFake();
    let finished = false;
    const request = server
      .simulateLine(
        socket,
        JSON.stringify({
          id: "bounded",
          command: "set_appearance",
          sessionUuid: "live",
          mode: "dark",
        }),
      )
      .then(() => {
        finished = true;
      });
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
    }
    expect(applied).toEqual(["hung:dark"]);
    timer.advanceTime(26);
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
    }
    expect(applied).toEqual(["hung:dark", "ready:dark"]);
    expect(finished).toBe(true);
    await request;
    expect(triggered).toBe(true);
    expect(socket.getWrittenMessages<AppearanceSocketResponse>()).toEqual([
      {
        id: "bounded",
        type: "appearance_response",
        success: true,
        result: { config: expect.any(Object), appliedMode: "dark" },
      },
    ]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  describe("validation and command resolution (rejects before side effects)", () => {
    interface Row {
      name: string;
      request: Record<string, unknown>;
      expectedError: string;
    }

    // Byte-for-byte against src: default case throws
    // `Unsupported appearance command: ${command}` (~:91); set_appearance throws
    // "set_appearance requires mode: light | dark | auto" (~:71); set_appearance_sync
    // throws "set_appearance_sync requires enabled boolean" (~:53). createErrorResponse
    // (~:95-99) wraps each as { id, type:"appearance_response", success:false, error }.
    const rows: Row[] = [
      {
        name: "neither command nor method → unsupported (missing fields)",
        request: { id: "r1", mode: "light" },
        expectedError: "Unsupported appearance command: undefined",
      },
      {
        name: "unknown command → unsupported",
        request: { id: "r2", command: "bogus" },
        expectedError: "Unsupported appearance command: bogus",
      },
      {
        name: "set_appearance empty-string mode (top-level shape) → requires mode",
        request: { id: "r3", command: "set_appearance", mode: "" },
        expectedError: "set_appearance requires mode: light | dark | auto",
      },
      {
        name: "set_appearance unknown mode (params shape) → requires mode",
        request: { id: "r4", command: "set_appearance", params: { mode: "purple" } },
        expectedError: "set_appearance requires mode: light | dark | auto",
      },
      {
        name: "set_appearance via method shape resolves the command (method fallback)",
        request: { id: "r5", method: "set_appearance", mode: "nope" },
        expectedError: "set_appearance requires mode: light | dark | auto",
      },
      {
        name: "set_appearance_sync non-boolean enabled (top-level shape) → requires boolean",
        request: { id: "r6", command: "set_appearance_sync", enabled: "yes" },
        expectedError: "set_appearance_sync requires enabled boolean",
      },
      {
        name: "set_appearance_sync non-boolean enabled (params shape) → requires boolean",
        request: { id: "r7", command: "set_appearance_sync", params: { enabled: 5 } },
        expectedError: "set_appearance_sync requires enabled boolean",
      },
      {
        name: "set_appearance_sync via method shape resolves the command (method fallback)",
        request: { id: "r8", method: "set_appearance_sync", enabled: null },
        expectedError: "set_appearance_sync requires enabled boolean",
      },
    ];

    for (const row of rows) {
      it(row.name, async () => {
        await server.simulateLine(socket, JSON.stringify(row.request));

        const messages = socket.getWrittenMessages<AppearanceSocketResponse>();
        expect(messages).toHaveLength(1);
        expect(messages[0]).toEqual({
          id: row.request.id as string,
          type: "appearance_response",
          success: false,
          error: row.expectedError,
        });
      });
    }

    it("resolves the mode param equivalently from params and top-level shapes", async () => {
      // Both dual-shape carriers for an INVALID mode reject with the SAME error,
      // proving `request.params?.mode ?? request.mode` reads both shapes.
      const topLevel = new FakeSocket();
      const params = new FakeSocket();

      await server.simulateLine(
        topLevel,
        JSON.stringify({ id: "eq-top", command: "set_appearance", mode: "zzz" }),
      );
      await server.simulateLine(
        params,
        JSON.stringify({ id: "eq-params", command: "set_appearance", params: { mode: "zzz" } }),
      );

      const topMsg = topLevel.getWrittenMessages<AppearanceSocketResponse>()[0];
      const paramsMsg = params.getWrittenMessages<AppearanceSocketResponse>()[0];
      expect(topMsg.error).toBe("set_appearance requires mode: light | dark | auto");
      expect(paramsMsg.error).toBe(topMsg.error);
    });
  });

  it("rejects a missing session before validating a mutating request", async () => {
    const authenticator = new SessionScopedStreamAuthenticator(
      sessionManager,
      "appearance",
      {} as NodeJS.ProcessEnv,
    );
    const authServer = new TestableAppearanceSocketServer(timer, authenticator);
    await authServer.startFake();
    await authServer.simulateLine(
      socket,
      JSON.stringify({ id: "missing", command: "set_appearance", mode: "invalid" }),
    );
    expect(socket.getWrittenMessages<AppearanceSocketResponse>()[0].error).toContain(
      "requires an authenticated daemon session",
    );
  });

  it("rejects an empty session on set_appearance_sync before validating enabled", async () => {
    const authServer = new TestableAppearanceSocketServer(
      timer,
      new SessionScopedStreamAuthenticator(sessionManager, "appearance", {} as NodeJS.ProcessEnv),
    );
    await authServer.startFake();
    await authServer.simulateLine(
      socket,
      JSON.stringify({ id: "empty", command: "set_appearance_sync", sessionUuid: "  " }),
    );
    expect(socket.getWrittenMessages<AppearanceSocketResponse>()[0].error).toContain(
      "requires an authenticated daemon session",
    );
  });

  it("rejects an unknown session before changing config", async () => {
    let updates = 0;
    const dependencies = fakeDependencies();
    const originalUpdate = dependencies.updateConfig;
    dependencies.updateConfig = async (update) => {
      updates++;
      return originalUpdate(update);
    };
    const authServer = new TestableAppearanceSocketServer(
      timer,
      new SessionScopedStreamAuthenticator(sessionManager, "appearance", {} as NodeJS.ProcessEnv),
      emptyDeviceSource,
      dependencies,
    );
    await authServer.startFake();
    await authServer.simulateLine(
      socket,
      JSON.stringify({
        id: "unknown",
        command: "set_appearance",
        sessionUuid: "ghost",
        mode: "dark",
      }),
    );
    expect(updates).toBe(0);
    expect(socket.getWrittenMessages<AppearanceSocketResponse>()[0].error).toContain(
      "not an active daemon session",
    );
  });

  for (const command of ["set_appearance", "set_appearance_sync"] as const) {
    it(`${command} applies only to caller-owned devices, excluding other owners and unowned devices`, async () => {
      const applied: string[] = [];
      const manager = ownershipManager();
      const dependencies = fakeDependencies(applied);
      let syncs = 0;
      dependencies.triggerSync = async () => {
        syncs++;
      };
      const authServer = new TestableAppearanceSocketServer(
        timer,
        new SessionScopedStreamAuthenticator(() => manager, "appearance", {}),
        ownedDeviceSource({ manager, pooled: ["own", "other", "unowned"], current: "own" }),
        dependencies,
      );
      await authServer.startFake();
      await authServer.simulateLine(
        socket,
        JSON.stringify({
          id: "scoped",
          command,
          sessionUuid: "live",
          mode: "dark",
          enabled: true,
        }),
      );
      const mode = command === "set_appearance" ? "dark" : "light";
      expect(applied).toEqual([`own:${mode}`]);
      expect(syncs).toBe(1);
      expect(socket.getWrittenMessages<AppearanceSocketResponse>()[0]).toMatchObject({
        success: true,
        result: { appliedMode: mode },
      });
    });

    it(`${command} persists config and succeeds without appliedMode when a live caller owns no device`, async () => {
      const applied: string[] = [];
      const manager = ownershipManager();
      const dependencies = fakeDependencies(applied);
      let syncs = 0;
      dependencies.triggerSync = async () => {
        syncs++;
      };
      const authServer = new TestableAppearanceSocketServer(
        timer,
        new SessionScopedStreamAuthenticator(() => manager, "appearance", {}),
        ownedDeviceSource({ manager, pooled: ["own", "unowned"], current: "unowned-current" }),
        dependencies,
      );
      await authServer.startFake();
      await authServer.simulateLine(
        socket,
        JSON.stringify({
          id: "no-device",
          command,
          sessionUuid: "no-device",
          mode: "dark",
          enabled: true,
        }),
      );
      const expectedConfig =
        command === "set_appearance"
          ? { ...initialConfig, defaultMode: "dark", syncWithHost: false }
          : { ...initialConfig, syncWithHost: true };
      expect(applied).toEqual([]);
      expect(await dependencies.getConfig()).toEqual(expectedConfig);
      expect(syncs).toBe(1);
      expect(socket.getWrittenMessages<AppearanceSocketResponse>()[0]).toEqual({
        id: "no-device",
        type: "appearance_response",
        success: true,
        result: { config: expectedConfig },
      });
    });
  }

  it("keeps two sessions' appearance changes confined to their own devices", async () => {
    const applied: string[] = [];
    const manager = ownershipManager();
    const authServer = new TestableAppearanceSocketServer(
      timer,
      new SessionScopedStreamAuthenticator(() => manager, "appearance", {}),
      ownedDeviceSource({ manager, pooled: ["own", "other", "unowned"] }),
      fakeDependencies(applied),
    );
    await authServer.startFake();
    for (const [sessionUuid, mode, expected] of [
      ["live", "dark", "own:dark"],
      ["different", "light", "other:light"],
    ]) {
      applied.length = 0;
      const callerSocket = new FakeSocket();
      await authServer.simulateLine(
        callerSocket,
        JSON.stringify({
          id: sessionUuid,
          command: "set_appearance",
          sessionUuid,
          mode,
        }),
      );
      expect(applied).toEqual([expected]);
      expect(callerSocket.getWrittenMessages<AppearanceSocketResponse>()[0].success).toBe(true);
    }
  });

  it("never applies to an unowned current device when the caller owns a pooled device", async () => {
    const applied: string[] = [];
    const manager = ownershipManager();
    const authServer = new TestableAppearanceSocketServer(
      timer,
      new SessionScopedStreamAuthenticator(() => manager, "appearance", {}),
      ownedDeviceSource({ manager, pooled: ["own"], current: "unowned-current" }),
      fakeDependencies(applied),
    );
    await authServer.startFake();
    await authServer.simulateLine(
      socket,
      JSON.stringify({
        id: "current",
        command: "set_appearance",
        sessionUuid: "live",
        mode: "dark",
      }),
    );
    expect(applied).toEqual(["own:dark"]);
    expect(socket.getWrittenMessages<AppearanceSocketResponse>()[0].success).toBe(true);
  });

  it("resolves both label callers and label owners to the base session's devices", async () => {
    const applied: string[] = [];
    const manager = ownershipManager();
    const authServer = new TestableAppearanceSocketServer(
      timer,
      new SessionScopedStreamAuthenticator(() => manager, "appearance", {}),
      ownedDeviceSource({ manager, pooled: ["own", "label-owned", "other", "unowned"] }),
      fakeDependencies(applied),
    );
    await authServer.startFake();
    await authServer.simulateLine(
      socket,
      JSON.stringify({
        id: "label",
        command: "set_appearance",
        sessionUuid: " live:phone ",
        mode: "dark",
      }),
    );
    expect(applied).toEqual(["own:dark", "label-owned:dark"]);
    expect(socket.getWrittenMessages<AppearanceSocketResponse>()[0].success).toBe(true);
  });

  it("keeps get_appearance_config available without a session", async () => {
    const authServer = new TestableAppearanceSocketServer(
      timer,
      new SessionScopedStreamAuthenticator(sessionManager, "appearance", {} as NodeJS.ProcessEnv),
    );
    await authServer.startFake();
    await authServer.simulateLine(
      socket,
      JSON.stringify({ id: "read", command: "get_appearance_config" }),
    );
    expect(socket.getWrittenMessages<AppearanceSocketResponse>()[0]).toMatchObject({
      success: true,
      result: { config: initialConfig },
    });
  });

  for (const sessionUuid of [undefined, "live:phone"]) {
    it(`auth disabled preserves all-candidate targeting with session ${sessionUuid}`, async () => {
      const applied: string[] = [];
      const manager = ownershipManager();
      const source = ownedDeviceSource({
        manager,
        pooled: ["own", "other", "unowned"],
        current: "unowned-current",
      });
      // Auth-off is intentionally the existing all-devices behavior, even with a supplied UUID.
      source.getSessionForDevice = () => {
        throw new Error("auth-off must not look up ownership");
      };
      const authServer = new TestableAppearanceSocketServer(
        timer,
        new SessionScopedStreamAuthenticator(() => manager, "appearance", {
          [STREAM_SOCKET_AUTH_ENV]: "0",
        }),
        source,
        fakeDependencies(applied),
      );
      await authServer.startFake();
      await authServer.simulateLine(
        socket,
        JSON.stringify({
          id: "opt-out",
          command: "set_appearance",
          sessionUuid,
          mode: "dark",
        }),
      );
      expect(applied).toEqual(["own:dark", "other:dark", "unowned:dark", "unowned-current:dark"]);
      expect(socket.getWrittenMessages<AppearanceSocketResponse>()[0]).toMatchObject({
        success: true,
        result: { appliedMode: "dark" },
      });
    });
  }
});
