import { expect, spyOn, test } from "bun:test";
import * as versions from "../../src/utils/mcpVersion";
import * as constants from "../../src/daemon/wire/constants";
import { DaemonClient } from "../../src/daemon/client";
import * as net from "node:net";
import { DaemonMcpProxy, DaemonVersionMismatchError } from "../../src/daemon/daemonMcpProxy";
import { SocketServerRuntime } from "../../src/daemon/socketServerParts/SocketServerRuntime";
import { evaluateClientHandshake } from "../../src/daemon/wire/daemonHandshake";
import { shapeToolCallError } from "../../src/daemon/shapeToolCallError";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeSocket } from "../fakes/FakeNetServer";
import { connectionListenerOf } from "../helpers/netConnectionListener";
import { ISOLATED_DAEMON_RECOVERY } from "../helpers/isolatedDaemonRecovery";
import { fakeBindLock, unreachableMcpDispatcher } from "../helpers/createTestUnixSocketServer";
import { createFakeDaemonState } from "./helpers/inputSocketHarness";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  DaemonIdentity,
  type DaemonIdentityHost,
} from "../../src/daemon/daemonCore/DaemonIdentity";
import type { PidFileData } from "../../src/daemon/types";

// Objects constructed before the background probe finishes must use the same
// settled identity as PID metadata and the daemon's server-side handshake.
test("daemon settlement updates a client constructed before dirty refinement", async () => {
  const timer = new FakeTimer();
  const resolver = versions.createMcpVersionResolver({
    env: {},
    readPackageVersion: () => "0.0.39",
    readGitVersion: () => ({ shortSha: "abcdef123456", dirty: false }),
    readDirtyState: async () => ({ dirty: true, dirtyHash: "aaaaaaaaaaaa" }),
    timer,
  });
  const probe = spyOn(versions, "getSettledMcpServerVersion").mockImplementation(() =>
    resolver.resolveSettled(),
  );
  const client = new DaemonClient("/fake/socket", 1000, timer);
  const server = new SocketServerRuntime(
    [
      "/fake/socket",
      createFakeDaemonState(new Map()),
      timer,
      undefined,
      { mcpDispatcher: unreachableMcpDispatcher },
      undefined,
      { bindLock: fakeBindLock },
    ],
    () => {
      throw new Error("No server operations expected");
    },
    shapeToolCallError,
    () => 1024,
  );
  try {
    const settled = await constants.resolveDaemonVersion();
    expect(settled).toBe("0.0.39+gabcdef123456.dirty.aaaaaaaaaaaa");
    expect(constants.DAEMON_VERSION).toBe(settled);
    expect(client.testHooks.declaredIdentity()?.version).toBe(settled);
    expect(server.daemonIdentity.version).toBe(settled);
    expect(evaluateClientHandshake(server.daemonIdentity, { clientVersion: settled }).ok).toBe(
      true,
    );
    expect(
      evaluateClientHandshake(server.daemonIdentity, {
        clientVersion: "0.0.39+gabcdef123456.dirty.bbbbbbbbbbbb",
      }).ok,
    ).toBe(true);
    expect(
      evaluateClientHandshake(server.daemonIdentity, {
        clientVersion: "0.0.39+g123456abcdef.dirty.aaaaaaaaaaaa",
      }).ok,
    ).toBe(false);
    timer.advanceTime(0);
    expect(await constants.resolveDaemonVersion()).toBe(settled);
  } finally {
    probe.mockRestore();
    await constants.resolveDaemonVersion();
  }
});

test("default client waits for refinement before opening a handshake connection", async () => {
  const pending = Promise.withResolvers<string>();
  const unsettled = spyOn(versions, "isMcpServerVersionSettled").mockReturnValue(false);
  const probe = spyOn(versions, "getSettledMcpServerVersion").mockReturnValue(pending.promise);
  const socket = new FakeSocket();
  const connect = spyOn(net, "createConnection").mockImplementation((...args: unknown[]) => {
    const connected = connectionListenerOf(args)!;
    queueMicrotask(connected);
    return socket;
  });
  const client = new DaemonClient(
    "/fake/socket",
    1000,
    new FakeTimer(),
    ISOLATED_DAEMON_RECOVERY,
    undefined,
    { platformOverride: "win32" },
  );
  try {
    const connection = client.connect();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    const settled = "0.0.39+gabcdef123456.dirty.aaaaaaaaaaaa";
    pending.resolve(settled);
    await connection;
    expect(connect).toHaveBeenCalledTimes(1);
    expect(client.testHooks.declaredIdentity()?.version).toBe(settled);
  } finally {
    pending.resolve("0.0.39");
    await client.close();
    socket.destroy();
    connect.mockRestore();
    probe.mockRestore();
    unsettled.mockRestore();
    await constants.resolveDaemonVersion();
  }
});

// Boundaries must add no microtask turns once the stamp can no longer change:
// FakeTimer-driven proxy tests spin a bounded number of turns (#6336 suites).
test("a settled version is copied synchronously without awaiting the probe", async () => {
  const final = "0.0.39+gabcdef123456.dirty.dddddddddddd";
  const settledNow = spyOn(versions, "isMcpServerVersionSettled").mockReturnValue(true);
  const current = spyOn(versions, "getMcpServerVersion").mockReturnValue(final);
  const probe = spyOn(versions, "getSettledMcpServerVersion");
  try {
    expect(constants.syncSettledDaemonVersion()).toBe(true);
    expect(constants.DAEMON_VERSION).toBe(final);
    expect(probe).not.toHaveBeenCalled();
    settledNow.mockReturnValue(false);
    expect(constants.syncSettledDaemonVersion()).toBe(false);
  } finally {
    settledNow.mockRestore();
    current.mockRestore();
    probe.mockRestore();
    await constants.resolveDaemonVersion();
  }
});

test.each(["matching dirty daemon", "clean daemon at the same HEAD"])(
  "proxy constructed before settlement checks the refined identity against %s",
  async (scenario) => {
    const plain = "0.0.39+gabcdef123456";
    const dirty = `${plain}.dirty.aaaaaaaaaaaa`;
    const unsettled = spyOn(versions, "isMcpServerVersionSettled").mockReturnValue(false);
    const probe = spyOn(versions, "getSettledMcpServerVersion").mockResolvedValue(plain);
    await constants.resolveDaemonVersion();
    const manager = new FakeDaemonManager();
    manager.statusResult = {
      ...manager.statusResult,
      version: scenario === "matching dirty daemon" ? dirty : plain,
      startedAt: 1,
    };
    const client = new FakeDaemonClient({ toolResult: { content: [] } });
    const proxy = new DaemonMcpProxy({
      daemonManager: manager,
      clientFactory: () => client,
      autoStartDaemon: false,
      timer: new FakeTimer(),
      daemonAvailabilityProbe: async () => true,
    });
    probe.mockResolvedValue(dirty);
    try {
      const call = proxy.callTool("getAndroid", { deviceId: "emulator-5554" });
      if (scenario === "matching dirty daemon") {
        await call;
        expect(client.callToolCalls).toHaveLength(1);
      } else {
        await expect(call).rejects.toBeInstanceOf(DaemonVersionMismatchError);
        expect(client.callToolCalls).toHaveLength(0);
      }
      expect(manager.restartCalled).toBe(false);
      expect(constants.DAEMON_VERSION).toBe(dirty);
    } finally {
      await proxy.close();
      probe.mockRestore();
      unsettled.mockRestore();
      await constants.resolveDaemonVersion();
    }
  },
);

test("PID publication records the settled identity, not the import-time clean stamp", async () => {
  const dirty = "0.0.39+gabcdef123456.dirty.cccccccccccc";
  const unsettled = spyOn(versions, "isMcpServerVersionSettled").mockReturnValue(false);
  const probe = spyOn(versions, "getSettledMcpServerVersion").mockResolvedValue(dirty);
  const written: PidFileData[] = [];
  const unexpected = (): never => {
    throw new Error("not used by writePidFile");
  };
  const host: DaemonIdentityHost = {
    pidFileWritten: () => false,
    setPidFileWritten: () => {},
    services: { options: () => ({}) },
    identity: {
      port: () => 0,
      completeIdentityPublished: () => false,
      socketBindCommitted: () => false,
      incumbentOwnerGuard: unexpected,
      daemonSessionId: () => "session-1",
      generationStartedAt: () => 1,
      processStartedAt: () => 1,
      processGenerationToken: () => undefined,
    },
    cleanupDaemonFilesForShutdown: unexpected,
    writeEarlyOwnerRecord: unexpected,
    persistPidFileData: async (data) => {
      written.push(data);
    },
  };
  const identity = new DaemonIdentity(
    host,
    { stat: () => ({ dev: 0n, ino: 0n }) },
    "linux",
    () => "/fake/auto-mobile.db",
  );
  try {
    await identity.writePidFile();
    expect(probe).toHaveBeenCalled();
    expect(written).toHaveLength(1);
    expect(written[0]?.version).toBe(dirty);
  } finally {
    probe.mockRestore();
    unsettled.mockRestore();
    await constants.resolveDaemonVersion();
  }
});
