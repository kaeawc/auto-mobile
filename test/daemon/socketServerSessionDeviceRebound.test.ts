import { describe, expect, test } from "bun:test";
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

/** The socket's recorded route, as a routed call leaves it. */
function bind(server: ReturnType<typeof harness>["server"], socketId: string, sessionUuid: string) {
  // oxlint-disable-next-line auto-mobile/no-unknown-cast -- the route map is protected runtime state with no test hook
  const runtime = server as unknown as {
    runtime: {
      boundMcpClientKeysBySocketSession: Map<string, { clientKey: string; sessionUuid: string }>;
    };
  };
  runtime.runtime.boundMcpClientKeysBySocketSession.set(socketId, { clientKey: "k", sessionUuid });
}

const flush = async () => {
  for (let turn = 0; turn < 5; turn++) {
    await Promise.resolve();
  }
};

const rebounds = (frames: Map<string, DaemonNotification[]>, id: string) =>
  frames.get(id)!.filter((frame) => frame.method === SESSION_DEVICE_REBOUND_NOTIFICATION_METHOD);

describe("session_device_rebound reaches only sockets that hold the session (#15456)", () => {
  test("a socket bound by a routed call and the connection that acquired it are told; others are not", async () => {
    const { server, frames } = harness(new Set(["B:s"]));
    bind(server, "A", "s");
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

  test("a socket bound to a different session is not told", async () => {
    const { server, frames } = harness(new Set());
    bind(server, "A", "t");
    server.testHooks.transport.broadcastSessionDeviceRebound(EVENT);
    await flush();
    for (const id of ["A", "B", "C"]) {
      expect(rebounds(frames, id)).toHaveLength(0);
    }
  });
});
