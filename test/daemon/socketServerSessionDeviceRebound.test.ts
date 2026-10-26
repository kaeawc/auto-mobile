import { describe, expect, test } from "bun:test";
import { McpBindings } from "../../src/daemon/socketServerParts/McpBindings";
import { createHarnessServer } from "./helpers/UnixSocketServerHarness";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DaemonNotification } from "../../src/daemon/types";
import {
  SESSION_DEVICE_REBOUND_NOTIFICATION_METHOD,
  type SessionDeviceRebound,
} from "../../src/daemon/sessionDeviceReboundBroadcast";

const EVENT: SessionDeviceRebound = {
  sessionId: "s",
  previousDeviceId: "emulator-5554",
  deviceId: "emulator-5556",
  generation: 1,
  stableDeviceId: "Pixel",
  avdName: "Pixel",
};

/** Three subscribed sockets; the pool names "B" as the connection that acquired session "s". */
function harness(ownedBy: ReadonlySet<string>) {
  const unexpected = (): never => {
    throw new Error("Unexpected daemon state access");
  };
  const server = createHarnessServer(
    "unused",
    {
      isInitialized: () => true,
      getSessionManager: unexpected,
      getDevicePool: () =>
        ({
          isSessionOwnedByConnection: (sessionId: string, socketId?: string) =>
            socketId !== undefined && ownedBy.has(`${socketId}:${sessionId}`),
        }) as never,
      getDeviceSessionRegistry: unexpected,
    },
    new FakeTimer(),
  );
  const frames = new Map<string, DaemonNotification[]>();
  for (const id of ["A", "B", "C"]) {
    const socket = new FakeSocket<DaemonNotification>();
    frames.set(id, []);
    socket.onWrite = (frame) => frames.get(id)!.push(JSON.parse(frame));
    server.state.notificationSubscribers.add(id);
    server.state.clientSockets.set(id, socket);
  }
  return { server, frames };
}

const flush = async () => {
  for (let turn = 0; turn < 5; turn++) {
    await Promise.resolve();
  }
};

const rebounds = (frames: Map<string, DaemonNotification[]>, id: string) =>
  frames.get(id)!.filter((frame) => frame.method === SESSION_DEVICE_REBOUND_NOTIFICATION_METHOD);

describe("session_device_rebound reaches only sockets that hold the session (#15456)", () => {
  test("connections that own the session are told; a subscriber that does not is not", async () => {
    const { server, frames } = harness(new Set(["A:s", "B:s"]));
    server.testHooks.transport.broadcastSessionDeviceRebound(EVENT);
    await flush();
    expect(rebounds(frames, "A")).toHaveLength(1);
    expect(rebounds(frames, "B")).toHaveLength(1);
    expect(rebounds(frames, "C")).toHaveLength(0);
    expect(rebounds(frames, "A")[0]).toMatchObject({ sessionId: "s", deviceId: "emulator-5556" });
  });

  test("a derived label session is held through its base session", async () => {
    const { server, frames } = harness(new Set(["B:s"]));
    server.testHooks.transport.broadcastSessionDeviceRebound({ ...EVENT, sessionId: "s:second" });
    await flush();
    expect(rebounds(frames, "B")).toHaveLength(1);
    expect(rebounds(frames, "A")).toHaveLength(0);
    expect(rebounds(frames, "C")).toHaveLength(0);
  });

  test("a session owned by no connection reaches nobody", async () => {
    const { server, frames } = harness(new Set());
    server.testHooks.transport.broadcastSessionDeviceRebound(EVENT);
    await flush();
    for (const id of ["A", "B", "C"]) {
      expect(rebounds(frames, id)).toHaveLength(0);
    }
  });
});

describe("McpBindings.holdsSession", () => {
  function bindings(routes: Record<string, string>) {
    const unexpected = (): never => {
      throw new Error("Unexpected daemon state access");
    };
    const routeMap = new Map(
      Object.entries(routes).map(([socketId, sessionUuid]) => [
        socketId,
        { clientKey: "k", sessionUuid },
      ]),
    );
    return new McpBindings(
      {
        clientSockets: new Map(),
        daemonState: {
          isInitialized: () => false,
          getSessionManager: unexpected,
          getDevicePool: unexpected,
          getDeviceSessionRegistry: unexpected,
        },
        boundMcpClientKeysBySocketSession: routeMap,
        clearConnectionDevicePin: () => {},
      },
      () => ({}) as never,
    );
  }

  test("a socket whose last routed call named the session, or its base, holds it", () => {
    const held = bindings({ A: "s", B: "t" });
    expect(held.holdsSession("A", "s")).toBe(true);
    expect(held.holdsSession("A", "s:second")).toBe(true);
    expect(held.holdsSession("B", "s")).toBe(false);
    expect(held.holdsSession("C", "s")).toBe(false);
  });
});
