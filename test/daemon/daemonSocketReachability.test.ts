import { EventEmitter } from "node:events";
import type { createConnection, Socket } from "node:net";
import { describe, expect, test } from "bun:test";
import {
  classifySocketConnectError,
  createObservationOnlyConnectAttempt,
  DaemonSocketReachability,
  type SocketReachability,
} from "../../src/daemon/daemonSocketReachability";
import { FakeTimer } from "../fakes/FakeTimer";

describe("classifySocketConnectError", () => {
  for (const platform of ["linux", "darwin", "win32"] satisfies NodeJS.Platform[]) {
    test(`${platform} only treats explicitly absent errnos as absent`, () => {
      for (const code of ["ECONNREFUSED", "ENOENT"]) {
        expect(classifySocketConnectError(code, platform)).toBe("absent");
      }
      for (const code of [
        "EACCES",
        "EPERM",
        "EMFILE",
        "ENFILE",
        "EAGAIN",
        "EBUSY",
        "ECONNRESET",
        "EPIPE",
        "ETIMEDOUT",
        "ENOTSOCK",
        "ENOMEM",
        undefined,
        "EWHATEVER",
      ]) {
        expect(classifySocketConnectError(code, platform)).toBe("unknown");
      }
    });
  }
});

describe("DaemonSocketReachability", () => {
  test("missing POSIX paths are absent without connecting", async () => {
    let calls = 0;
    const probe = new DaemonSocketReachability({
      platform: "linux",
      existsSyncFn: () => false,
      connectAttempt: async () => {
        calls++;
        return "answered";
      },
    });
    expect(await probe.probe("missing.sock", 50)).toBe("absent");
    expect(calls).toBe(0);
  });

  test("missing Windows filesystem paths still connect", async () => {
    let calls = 0;
    const probe = new DaemonSocketReachability({
      platform: "win32",
      existsSyncFn: () => false,
      connectAttempt: async () => {
        calls++;
        return "answered";
      },
    });
    expect(await probe.probe("pipe", 50)).toBe("answered");
    expect(calls).toBe(1);
  });

  test.each([0, -1])(
    "budget %s learns nothing without filesystem or connect I/O",
    async (budget) => {
      const probe = new DaemonSocketReachability({
        existsSyncFn: () => {
          throw new Error("no budget for filesystem");
        },
        connectAttempt: async () => {
          throw new Error("no budget for connect");
        },
      });
      expect(await probe.probe("socket", budget)).toBe("unknown");
    },
  );

  test.each(["answered", "absent", "unknown"] satisfies SocketReachability[])(
    "passes through %s and injected dependencies",
    async (result) => {
      const timer = new FakeTimer();
      const probe = new DaemonSocketReachability({
        platform: "darwin",
        existsSyncFn: () => true,
        timer,
        connectAttempt: async (path, budget, receivedTimer, platform) => {
          expect(path).toBe("socket");
          expect(budget).toBe(50);
          expect(receivedTimer).toBe(timer);
          expect(platform).toBe("darwin");
          return result;
        },
      });
      const pending = probe.probe("socket", 50);
      await Promise.resolve();
      timer.advanceTime(50);
      expect(await pending).toBe(result);
    },
  );

  test.each(["answered", "unknown", "absent"] satisfies SocketReachability[])(
    "confirms POSIX absence after 50 ms and returns %s",
    async (second) => {
      const timer = new FakeTimer();
      let calls = 0;
      const probe = new DaemonSocketReachability({
        platform: "darwin",
        existsSyncFn: () => true,
        timer,
        connectAttempt: async () => (++calls === 1 ? "absent" : second),
      });
      const pending = probe.probe("socket", 20);
      await Promise.resolve();
      expect(calls).toBe(1);
      expect(timer.getPendingSleeps()).toEqual([50]);
      timer.advanceTime(49);
      await Promise.resolve();
      expect(calls).toBe(1);
      timer.advanceTime(1);
      expect(await pending).toBe(second);
      expect(calls).toBe(2);
    },
  );

  test("Windows absence is not retried", async () => {
    const timer = new FakeTimer();
    let calls = 0;
    const probe = new DaemonSocketReachability({
      platform: "win32",
      existsSyncFn: () => true,
      timer,
      connectAttempt: async () => {
        calls++;
        return "absent";
      },
    });
    expect(await probe.probe("pipe", 20)).toBe("absent");
    expect(calls).toBe(1);
    expect(timer.getSleepCallCount()).toBe(0);
  });
});

class FakeProbeSocket extends EventEmitter {
  destroyCalls = 0;
  destroy(): this {
    this.destroyCalls++;
    return this;
  }
}

function connectFixture() {
  const socket = new FakeProbeSocket();
  const timer = new FakeTimer();
  const events: EventEmitter = socket;
  let connected = () => {};
  // Only the path/callback overload is used; no native socket is constructed.
  const connect = ((_path: string, callback: () => void) => {
    connected = callback;
    return events as Socket;
  }) as typeof createConnection;
  const attempt = createObservationOnlyConnectAttempt(connect);
  const pending = attempt("probe.sock", 20, timer, "linux");
  return { socket, timer, pending, connected: () => connected() };
}

describe("createObservationOnlyConnectAttempt", () => {
  test("connect answers, destroys the socket and clears its timeout", async () => {
    const f = connectFixture();
    expect(f.timer.getPendingTimeoutCount()).toBe(1);
    f.connected();
    expect(await f.pending).toBe("answered");
    expect(f.socket.destroyCalls).toBe(1);
    expect(f.timer.getPendingTimeoutCount()).toBe(0);
  });

  test.each([
    ["ECONNREFUSED", "absent"],
    ["ENOENT", "absent"],
    ["EACCES", "unknown"],
    ["EMFILE", "unknown"],
    [undefined, "unknown"],
  ] as const)("error %s reports %s and cleans up", async (code, expected) => {
    const f = connectFixture();
    f.socket.emit("error", Object.assign(new Error("connect failed"), { code }));
    expect(await f.pending).toBe(expected);
    expect(f.socket.destroyCalls).toBe(1);
    expect(f.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("timeout reports unknown and ignores late error and connect", async () => {
    const f = connectFixture();
    f.timer.advanceTime(19);
    expect(f.socket.destroyCalls).toBe(0);
    f.timer.advanceTime(1);
    expect(await f.pending).toBe("unknown");
    expect(f.socket.destroyCalls).toBe(1);
    expect(f.timer.getPendingTimeoutCount()).toBe(0);
    f.socket.emit("error", Object.assign(new Error("late"), { code: "ENOENT" }));
    f.connected();
    expect(await f.pending).toBe("unknown");
    expect(f.socket.destroyCalls).toBe(1);
  });
});
