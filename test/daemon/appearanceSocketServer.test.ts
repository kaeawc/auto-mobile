import { describe, it, expect, beforeEach } from "bun:test";
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
import { ActionableError, type AppearanceConfig, type BootedDevice } from "../../src/models";

/**
 * Drives requests through the real inherited processLine dispatch (queue +
 * handleLine + handleRequest) against only in-memory dependencies.
 */
const allowAllAuthenticator: StreamSocketAuthenticator = { authorize: () => {} };
const emptyDeviceSource: AppearanceDeviceSource = {
  getPooledDevices: () => [],
  getCurrentDevice: () => undefined,
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
  };
}

function sessionManager(): StreamAuthSessionManager {
  return {
    getSession: (sessionUuid) => (sessionUuid === "live" ? {} : null),
    getSessionForDevice: () => null,
    getDeviceLabels: () => undefined,
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
    useDefaultAuthenticator = false,
  ) {
    super(
      "/fake/path/appearance.sock",
      timer,
      useDefaultAuthenticator ? undefined : authenticator,
      deviceSource,
      dependencies,
    );
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
    const source: AppearanceDeviceSource = {
      getPooledDevices: () => [device("hung"), device("ready")],
      getCurrentDevice: () => undefined,
    };
    server = new TestableAppearanceSocketServer(timer, allowAllAuthenticator, source, dependencies);
    await server.startFake();
    let finished = false;
    const request = server
      .simulateLine(
        socket,
        JSON.stringify({ id: "bounded", command: "set_appearance", mode: "dark" }),
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

  it("applies only to devices owned by the caller or unowned", async () => {
    const applied: string[] = [];
    const source: AppearanceDeviceSource = {
      getPooledDevices: () => [device("own"), device("other"), device("unowned")],
      getCurrentDevice: () => device("own"),
    };
    const ownerByDevice = new Map([
      ["own", "live"],
      ["other", "different"],
    ]);
    const auth: StreamSocketAuthenticator = {
      authorize: ({ sessionUuid, deviceId }) => {
        if (sessionUuid !== "live") {
          throw new ActionableError("unknown session");
        }
        if (deviceId && ownerByDevice.get(deviceId) === "different") {
          throw new ActionableError("different daemon session");
        }
      },
    };
    const authServer = new TestableAppearanceSocketServer(
      timer,
      auth,
      source,
      fakeDependencies(applied),
    );
    await authServer.startFake();
    await authServer.simulateLine(
      socket,
      JSON.stringify({
        id: "scoped",
        command: "set_appearance",
        sessionUuid: "live",
        mode: "dark",
      }),
    );
    expect(applied).toEqual(["own:dark", "unowned:dark"]);
    expect(socket.getWrittenMessages<AppearanceSocketResponse>()[0]).toMatchObject({
      success: true,
      result: { appliedMode: "dark" },
    });
  });

  it("allows an owning session to apply sync mode", async () => {
    const applied: string[] = [];
    const source: AppearanceDeviceSource = {
      getPooledDevices: () => [device("own")],
      getCurrentDevice: () => undefined,
    };
    const auth = new SessionScopedStreamAuthenticator(
      () => ({ ...sessionManager(), getSessionForDevice: () => "live" }),
      "appearance",
      {} as NodeJS.ProcessEnv,
    );
    const authServer = new TestableAppearanceSocketServer(
      timer,
      auth,
      source,
      fakeDependencies(applied),
    );
    await authServer.startFake();
    await authServer.simulateLine(
      socket,
      JSON.stringify({
        id: "owned",
        command: "set_appearance_sync",
        sessionUuid: "live",
        enabled: true,
      }),
    );
    expect(applied).toEqual(["own:light"]);
    expect(socket.getWrittenMessages<AppearanceSocketResponse>()[0]).toMatchObject({
      success: true,
      result: { appliedMode: "light" },
    });
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

  it("honors the default authenticator's escape hatch without a session", async () => {
    const applied: string[] = [];
    const source: AppearanceDeviceSource = {
      getPooledDevices: () => [device("pooled")],
      getCurrentDevice: () => undefined,
    };
    const prior = process.env[STREAM_SOCKET_AUTH_ENV];
    process.env[STREAM_SOCKET_AUTH_ENV] = "0";
    try {
      const authServer = new TestableAppearanceSocketServer(
        timer,
        allowAllAuthenticator,
        source,
        fakeDependencies(applied),
        true,
      );
      await authServer.startFake();
      await authServer.simulateLine(
        socket,
        JSON.stringify({ id: "opt-out", command: "set_appearance", mode: "dark" }),
      );
      expect(applied).toEqual(["pooled:dark"]);
      expect(socket.getWrittenMessages<AppearanceSocketResponse>()[0]).toMatchObject({
        success: true,
        result: { appliedMode: "dark" },
      });
    } finally {
      if (prior === undefined) {
        delete process.env[STREAM_SOCKET_AUTH_ENV];
      } else {
        process.env[STREAM_SOCKET_AUTH_ENV] = prior;
      }
    }
  });
});
