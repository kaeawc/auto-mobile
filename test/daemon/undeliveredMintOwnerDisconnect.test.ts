import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { AcquisitionReceipt } from "../../src/daemon/acquisitionReceipt";
import {
  OwnerDisconnectExecutionVeto,
  OWNER_DISCONNECT_GRACE_MS,
  OWNER_DISCONNECTED_RELEASE_REASON,
} from "../../src/daemon/ownerDisconnectRelease";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { DaemonState } from "../../src/daemon/daemonState";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { getDbWriteBarrier, resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { logger, LogLevel } from "../../src/utils/logger";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";

const DEVICE = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
const CONNECTION = "minting-connection";
const managers: SessionManager[] = [];
let previousLogLevel: LogLevel;

beforeEach(() => {
  previousLogLevel = logger.getLogLevel();
  logger.setLogLevel(LogLevel.NONE);
});

afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.stopCleanupTimer();
  }
  DaemonState.getInstance().reset();
  expect(DaemonState.getInstance().isInitialized()).toBe(false);
  resetDbWriteBarrier();
  expect(getDbWriteBarrier().inFlightCount()).toBe(0);
  expect(getDbWriteBarrier().isDraining()).toBe(false);
  logger.setLogLevel(previousLogLevel);
  expect(logger.getLogLevel()).toBe(previousLogLevel);
});

async function harness(withControlVeto = false) {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const manager = new SessionManager(timer, persistence);
  managers.push(manager);
  manager.stopCleanupTimer();
  const reasons: string[] = [];
  manager.onSessionRelease((_id, _device, reason) => {
    reasons.push(reason);
  });
  const discovery = new FakeDeviceManager();
  discovery.bootedDevices = [DEVICE];
  let activeControl = false;
  const veto = new OwnerDisconnectExecutionVeto(() => activeControl, timer);
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "mint-test", {
      timer,
      idGenerator: new FakeIdGenerator(),
      deviceManager: discovery,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      ownerDisconnect: withControlVeto
        ? {
            release: async (session, reason) => {
              const deferral = veto.keeps(session);
              if (deferral) {
                return deferral;
              }
              await manager.releaseSessionIfOwned(
                session.sessionId,
                session,
                session.assignedDevice,
                reason,
              );
              await pool.releaseDevice(session.assignedDevice, session.sessionId);
            },
          }
        : undefined,
    }),
  );
  await pool.initializeWithDevices([DEVICE]);
  const claim = (connection = CONNECTION) => pool.beginMcpToolCall(connection);
  const bind = (
    id = "mint",
    oneShotCli = false,
    receipt?: AcquisitionReceipt,
    connection = CONNECTION,
  ) =>
    pool.bindOrReuseDeviceSession(
      id,
      DEVICE.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      connection,
      oneShotCli,
      receipt,
    );
  const mint = async (autolock: boolean) =>
    autolock
      ? (await pool.autolockDevice(
          DEVICE.deviceId,
          "android",
          CONNECTION,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { autolockEnabled: true },
        ))!
      : bind();
  const settle = (ms = 0) =>
    timer.advanceTimeAsync(ms, () => drainMicrotasks(FAKE_TIMER_QUIET_TURNS));
  const assertClean = () => {
    expect(pool["mcpSessionUndeliveredMints"]?.has(CONNECTION) ?? false).toBe(false);
    expect(pool["mcpSessionUndeliveredMints"]?.size ?? 0).toBe(0);
  };
  const assertReleased = async (id: string) => {
    await settle();
    expect(manager.hasSession(id)).toBe(false);
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ sessionId: null, status: "idle" });
    expect(discovery.bootedDevices).toEqual([DEVICE]);
    expect(reasons).toEqual([OWNER_DISCONNECTED_RELEASE_REASON]);
    expect((await persistence.getSession?.(id))?.release_reason).toBe(
      OWNER_DISCONNECTED_RELEASE_REASON,
    );
    expect(manager.getTerminalReleaseSnapshot(id)).toMatchObject({
      terminal: true,
      releaseReason: OWNER_DISCONNECTED_RELEASE_REASON,
    });
    assertClean();
  };
  return {
    timer,
    manager,
    pool,
    reasons,
    claim,
    bind,
    mint,
    settle,
    assertClean,
    assertReleased,
    control: (active: boolean) => {
      activeControl = active;
    },
  };
}

test("#11999 an unidentified tool-call claim ends idempotently without retaining connection state", async () => {
  const h = await harness();
  const end = h.pool.beginMcpToolCall?.(undefined) ?? h.pool.beginMcpBind(undefined);
  end();
  end();
  expect(h.pool["mcpBindsInFlight"].size).toBe(0);
  h.assertClean();
});

for (const autolock of [false, true]) {
  for (const closedAtCommit of [false, true]) {
    test(`#11999 ${autolock ? "autolock" : "explicit"} mint releases at zero delay when closed ${closedAtCommit ? "at commit" : "before answer"}`, async () => {
      const h = await harness();
      const end = h.claim();
      const minting = h.mint(autolock);
      if (closedAtCommit) {
        h.pool.releaseMcpSessionBindings(CONNECTION);
      }
      const id = await minting;
      expect(h.manager.hasSession(id)).toBe(true);
      if (!closedAtCommit) {
        h.pool.releaseMcpSessionBindings(CONNECTION);
      }
      expect(h.pool["ownerDisconnectRelease"].remainingMs(id)).toBe(0);
      end(false);
      end(false);
      await h.assertReleased(id);
      expect(h.pool["mcpBindsInFlight"].has(CONNECTION)).toBe(false);
      h.pool.releaseMcpSessionBindings(CONNECTION);
      await h.settle(OWNER_DISCONNECT_GRACE_MS);
      expect(h.reasons).toEqual([OWNER_DISCONNECTED_RELEASE_REASON]);
    });
  }
}

for (const closedAtCommit of [false, true]) {
  test(`#11999 a client-chosen mint closed ${closedAtCommit ? "at commit" : "before answer"} keeps ordinary grace`, async () => {
    const h = await harness();
    h.pool.declareMcpSessionLivenessOwnerToken(CONNECTION, "mint-owner-token");
    const end = h.claim();
    const receipt: AcquisitionReceipt = { clientChosenSessionId: "client-mint" };
    const minting = h.bind("client-mint", false, receipt);
    if (closedAtCommit) {
      h.pool.releaseMcpSessionBindings(CONNECTION);
    }
    const id = await minting;
    expect(receipt.minted?.clientSuppliedId).toBe(true);
    expect(h.manager.getSession(id)?.livenessOwnerToken).toBe(
      closedAtCommit ? undefined : "mint-owner-token",
    );
    h.assertClean();
    if (!closedAtCommit) {
      h.pool.releaseMcpSessionBindings(CONNECTION);
    }
    expect(h.pool["ownerDisconnectRelease"].remainingMs(id)).toBe(OWNER_DISCONNECT_GRACE_MS);
    end();
    await h.settle();
    expect(h.manager.hasSession(id)).toBe(true);
    await h.settle(OWNER_DISCONNECT_GRACE_MS - 1);
    expect(h.manager.hasSession(id)).toBe(true);
    await h.settle(1);
    await h.assertReleased(id);
  });
}

test("#11999 an undelivered claim retains its mint until close and a later undelivered end leaves no entry", async () => {
  const h = await harness();
  const end = h.claim();
  const laterEnd = h.claim();
  const id = await h.mint(false);
  end(false);
  end(true);
  expect(h.pool["mcpBindsInFlight"].get(CONNECTION)?.pending).toBe(1);
  expect(h.pool["mcpSessionUndeliveredMints"].get(CONNECTION)?.has(id)).toBe(true);
  h.pool.releaseMcpSessionBindings(CONNECTION);
  h.assertClean();
  laterEnd(false);
  expect(h.pool["mcpBindsInFlight"].has(CONNECTION)).toBe(false);
  await h.assertReleased(id);
});

for (const autolock of [false, true]) {
  test(`#11999 a ${autolock ? "autolock" : "explicit"} bind begun after close still sees the call-wide closed claim`, async () => {
    const h = await harness();
    const end = h.claim();
    h.pool.releaseMcpSessionBindings(CONNECTION);
    const id = await h.mint(autolock);
    end();
    await h.assertReleased(id);
  });
}

test("#11999 a closed one-shot CLI mint survives the zero-delay attempt under cli-idle", async () => {
  const h = await harness();
  const end = h.claim();
  h.pool.releaseMcpSessionBindings(CONNECTION);
  const id = await h.bind("cli-mint", true);
  h.manager.adoptCliLivenessPolicy(id);
  end();
  await h.settle(OWNER_DISCONNECT_GRACE_MS);
  expect(h.manager.getSession(id)?.livenessPolicy).toBe("cli-idle");
  expect(h.reasons).toEqual([]);
  expect(h.pool["ownerDisconnectRelease"].isPending(id)).toBe(false);
  h.assertClean();
});

test("#11999 a delivered mint keeps ordinary grace on later close", async () => {
  const h = await harness();
  const end = h.claim();
  const id = await h.mint(false);
  end();
  h.assertClean();
  h.pool.releaseMcpSessionBindings(CONNECTION);
  await h.settle(OWNER_DISCONNECT_GRACE_MS - 1);
  expect(h.manager.hasSession(id)).toBe(true);
  await h.settle(1);
  await h.assertReleased(id);
});

test("#11999 reusing a delivered session mid-call keeps ordinary grace", async () => {
  const h = await harness();
  const firstEnd = h.claim();
  const id = await h.bind();
  firstEnd();
  const end = h.claim();
  expect(await h.bind(id)).toBe(id);
  h.pool.releaseMcpSessionBindings(CONNECTION);
  end();
  await h.settle(OWNER_DISCONNECT_GRACE_MS - 1);
  expect(h.manager.hasSession(id)).toBe(true);
  await h.settle(1);
  await h.assertReleased(id);
});

test("#11999 joining a session another connection minted keeps ordinary grace", async () => {
  const h = await harness();
  const firstEnd = h.claim();
  const id = await h.mint(false);
  firstEnd();
  h.pool.releaseMcpSessionBindings(CONNECTION);
  const joiningConnection = "joining-connection";
  const end = h.claim(joiningConnection);
  await h.pool.restoreOwnedDeviceSessionsForMcpSession([id], joiningConnection);
  expect(await h.bind(id, false, undefined, joiningConnection)).toBe(id);
  h.assertClean();
  h.pool.releaseMcpSessionBindings(joiningConnection);
  end();
  await h.settle(OWNER_DISCONNECT_GRACE_MS - 1);
  expect(h.manager.hasSession(id)).toBe(true);
  await h.settle(1);
  await h.assertReleased(id);
});

test("#11999 a zero-delay release vetoed by control re-arms when control ends", async () => {
  const h = await harness(true);
  const end = h.claim();
  const id = await h.mint(false);
  h.control(true);
  h.pool.releaseMcpSessionBindings(CONNECTION);
  end();
  await h.settle();
  expect(h.manager.hasSession(id)).toBe(true);
  expect(h.pool["ownerDisconnectRelease"]["pending"].get(id)?.deferred).toBe(true);
  expect(h.pool["ownerDisconnectRelease"].isPending(id)).toBe(true);
  expect(h.pool["ownerDisconnectRelease"].remainingMs(id)).toBeUndefined();
  h.control(false);
  h.pool.sessionExecutionsEnded([id]);
  await h.assertReleased(id);
});

test("#11999 a new owner cancels the zero-delay release", async () => {
  const h = await harness();
  const end = h.claim();
  const id = await h.mint(false);
  h.pool.releaseMcpSessionBindings(CONNECTION);
  await h.pool.restoreOwnedDeviceSessionsForMcpSession([id], "new-owner");
  end();
  await h.settle();
  expect(h.manager.hasSession(id)).toBe(true);
  expect(h.pool["ownerDisconnectRelease"].isPending(id)).toBe(false);
  expect(h.reasons).toEqual([]);
  h.assertClean();
});

test("#11999 another connection ending does not acknowledge this connection's mint", async () => {
  const h = await harness();
  const end = h.claim();
  const otherEnd = h.claim("other-connection");
  const id = await h.mint(false);
  otherEnd();
  expect(h.pool["mcpSessionUndeliveredMints"]?.get(CONNECTION)?.has(id)).toBe(true);
  h.pool.releaseMcpSessionBindings(CONNECTION);
  end();
  await h.assertReleased(id);
});

test("#11999 any claim ending on the same connection conservatively acknowledges its mints", async () => {
  const h = await harness();
  const end = h.claim();
  const concurrentEnd = h.claim();
  const id = await h.mint(false);
  concurrentEnd();
  h.assertClean();
  h.pool.releaseMcpSessionBindings(CONNECTION);
  end();
  await h.settle(OWNER_DISCONNECT_GRACE_MS - 1);
  expect(h.manager.hasSession(id)).toBe(true);
  await h.settle(1);
  await h.assertReleased(id);
});

for (const closeBeforeUndo of [false, true]) {
  test(`#11999 acquisition undo ${closeBeforeUndo ? "after" : "before"} close records only its existing reason`, async () => {
    const h = await harness();
    const end = h.claim();
    const receipt: AcquisitionReceipt = { clientChosenSessionId: "mint" };
    const id = await h.bind("mint", false, receipt);
    h.assertClean();
    if (closeBeforeUndo) {
      h.pool.releaseMcpSessionBindings(CONNECTION);
    }
    await h.pool.releaseUndeliveredAcquisition(receipt);
    h.assertClean();
    h.pool.releaseMcpSessionBindings(CONNECTION);
    end();
    await h.settle(OWNER_DISCONNECT_GRACE_MS);
    expect(h.reasons).toEqual(["allocation-rollback"]);
    expect(h.manager.getTerminalReleaseSnapshot(id)).toBeUndefined();
  });
}

test("#11999 releasing a session clears its mint while its connection and claim stay open", async () => {
  const h = await harness();
  const end = h.claim();
  const id = await h.mint(false);
  expect(h.pool["mcpSessionUndeliveredMints"]?.get(CONNECTION)?.has(id)).toBe(true);
  await h.manager.releaseSession(id, "explicit-release");
  h.assertClean();
  h.pool.releaseMcpSessionBindings(CONNECTION);
  end();
  await h.settle();
  expect(h.reasons).toEqual(["explicit-release"]);
});

for (const blocker of ["cli-idle", "awaiting-owner", "handoff"] as const) {
  test(`#11999 zero-delay mint release preserves the ${blocker} blocker`, async () => {
    const h = await harness();
    const end = h.claim();
    const id = await h.mint(false);
    const session = h.manager.getSession(id)!;
    h.pool.releaseMcpSessionBindings(CONNECTION);
    if (blocker === "cli-idle") {
      h.manager.adoptCliLivenessPolicy(id);
    }
    if (blocker === "awaiting-owner") {
      session.ownership = "awaiting-owner";
    }
    if (blocker === "handoff") {
      await h.manager.claimLivenessOwnership(id, "old-owner");
      await h.manager.releaseLivenessOwnership(id, "old-owner");
    }
    end();
    await h.settle();
    expect(h.manager.hasSession(id)).toBe(true);
    expect(h.pool["ownerDisconnectRelease"].isPending(id)).toBe(false);
    expect(h.reasons).toEqual([]);
    h.assertClean();
  });
}

test("#11999 a direct pool mint without a socket answer claim keeps ordinary grace", async () => {
  const h = await harness();
  const id = await h.bind();
  h.assertClean();
  h.pool.releaseMcpSessionBindings(CONNECTION);
  await h.settle(OWNER_DISCONNECT_GRACE_MS - 1);
  expect(h.manager.hasSession(id)).toBe(true);
  await h.settle(1);
  await h.assertReleased(id);
});

for (const outcome of ["answer", "answerless", "throw", "replaced", "terminal"] as const) {
  test(`#11999 socket claim brackets forwarding and ${outcome} termination`, async () => {
    const h = await harness();
    const server = new UnixSocketServer(
      "/fake/mint.sock",
      "http://localhost:0/mcp",
      {
        isInitialized: () => true,
        getSessionManager: () => h.manager,
        getDevicePool: () => h.pool,
        getDeviceSessionRegistry: () => ({ list: () => [] }),
      },
      h.timer,
    );
    const events: string[] = [];
    const deliveries: Array<boolean | undefined> = [];
    const socket = new FakeSocket();
    server["clientSockets"].set(CONNECTION, socket);
    h.pool.beginMcpToolCall = (connection) => {
      expect(connection).toBe(CONNECTION);
      events.push("begin");
      return (delivered) => {
        events.push("end");
        deliveries.push(delivered);
      };
    };
    server["handleRequest"] = async () => {
      events.push("forward");
      expect(events).toEqual(["begin", "forward"]);
      if (outcome === "throw") {
        throw new Error("test forward failed");
      }
      if (outcome === "replaced") {
        server["clientSockets"].set(CONNECTION, new FakeSocket());
      }
      if (outcome === "terminal") {
        for (const pending of server["pendingSocketRequests"]) {
          pending.terminal = true;
        }
      }
      return outcome === "answerless"
        ? undefined
        : { id: "mint", type: "mcp_response", success: true };
    };
    server["writeTerminalSocketResponse"] = () => {
      events.push("write");
      expect(events).toEqual(["begin", "forward", "write"]);
    };
    await server["processSocketRequestLine"](
      CONNECTION,
      socket,
      JSON.stringify({
        id: "mint",
        type: "mcp_request",
        method: "tools/call",
        params: { name: "getAndroid" },
      }),
      h.timer.now(),
    );
    expect(events).toEqual(
      outcome === "answerless" || outcome === "terminal"
        ? ["begin", "forward", "end"]
        : ["begin", "forward", "write", "end"],
    );
    expect(deliveries).toEqual([outcome === "answer" || outcome === "throw"]);
  });
}

test("#11999 a failed optional socket claim still forwards and writes the answer", async () => {
  const h = await harness();
  const server = new UnixSocketServer(
    "/fake/mint.sock",
    "http://localhost:0/mcp",
    {
      isInitialized: () => true,
      getSessionManager: () => h.manager,
      getDevicePool: () => h.pool,
      getDeviceSessionRegistry: () => ({ list: () => [] }),
    },
    h.timer,
  );
  const events: string[] = [];
  const claimError = new Error("test claim failed");
  const previousWarn = logger.warn;
  const warning = spyOn(logger, "warn");
  h.pool.beginMcpToolCall = () => {
    events.push("begin");
    throw claimError;
  };
  server["handleRequest"] = async () => {
    events.push("forward");
    return { id: "mint", type: "mcp_response", success: true };
  };
  server["writeTerminalSocketResponse"] = () => {
    events.push("write");
  };
  try {
    await server["processSocketRequestLine"](
      CONNECTION,
      new FakeSocket(),
      JSON.stringify({
        id: "mint",
        type: "mcp_request",
        method: "tools/call",
      }),
      h.timer.now(),
    );
    expect(events).toEqual(["begin", "forward", "write"]);
    expect(warning).toHaveBeenCalledWith(
      "Could not begin MCP tool-call ownership claim: test claim failed",
      claimError,
    );
  } finally {
    warning.mockRestore();
    expect(logger.warn).toBe(previousWarn);
  }
});

test("#11999 socket close around the mint's answer uses its delivery status", async () => {
  for (const closeTiming of ["before-answer", "after-answer", "delivered"] as const) {
    const h = await harness();
    const server = new UnixSocketServer(
      "/fake/mint.sock",
      "http://localhost:0/mcp",
      {
        isInitialized: () => true,
        getSessionManager: () => h.manager,
        getDevicePool: () => h.pool,
        getDeviceSessionRegistry: () => ({ list: () => [] }),
      },
      h.timer,
    );
    server["acceptingRequests"] = true;
    const socket = new FakeSocket();
    server["handleConnection"](socket);
    const connection = [...server["sessions"].keys()][0]!;
    const minted = Promise.withResolvers<string>();
    const answer = Promise.withResolvers<void>();
    server.mcpClientFactory = async () => ({
      callTool: async ({ arguments: args }) => {
        const id = await h.pool.bindOrReuseDeviceSession(
          "socket-mint",
          DEVICE.deviceId,
          "android",
          undefined,
          undefined,
          undefined,
          false,
          undefined,
          undefined,
          undefined,
          String(args?.__mcpSessionId),
        );
        minted.resolve(id);
        await answer.promise;
        return { content: [] };
      },
      close: async () => {},
    });
    const request = server["processSocketRequestLine"](
      connection,
      socket,
      JSON.stringify({
        id: "socket-mint",
        type: "mcp_request",
        method: "tools/call",
        params: { name: "getAndroid", arguments: {} },
      }),
      h.timer.now(),
    );
    const id = await minted.promise;
    if (closeTiming === "before-answer") {
      socket.destroy();
    } else if (closeTiming === "after-answer") {
      // The transport is destroyed now; its close callback has not run yet.
      socket.destroyed = true;
      socket.writable = false;
    }
    answer.resolve();
    await request;
    if (closeTiming === "after-answer") {
      expect(h.pool["mcpSessionUndeliveredMints"].get(connection)?.has(id)).toBe(true);
      expect(h.pool["mcpBindsInFlight"].has(connection)).toBe(false);
      socket.emit("close");
    } else if (closeTiming === "delivered") {
      expect(h.pool["mcpSessionUndeliveredMints"].has(connection)).toBe(false);
      expect(socket.getWrittenMessages()).toContainEqual({
        id: "socket-mint",
        type: "mcp_response",
        success: true,
        result: { content: [] },
      });
      socket.destroy();
      await h.settle(OWNER_DISCONNECT_GRACE_MS - 1);
      expect(h.manager.hasSession(id)).toBe(true);
      await h.settle(1);
    }
    await h.assertReleased(id);
    expect(h.pool["mcpSessionUndeliveredMints"]?.has(connection) ?? false).toBe(false);
  }
});
