import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import {
  ControlConnection,
  type ControlConnectionSocket,
  isExpectedPeerClose,
  type ControlConnectionHandlers,
} from "../../../src/daemon/socketServer/ControlConnection";
import { DAEMON_RPC_SOCKET_PEER_END_FLUSH_GRACE_MS } from "../../../src/daemon/wire/constants";
import { DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS } from "../../../src/utils/deviceTimeouts";
import { FakeTimer } from "../../fakes/FakeTimer";

class FakeSocket extends EventEmitter implements ControlConnectionSocket {
  destroyed = false;
  writableLength = 0;
  readonly timeouts: number[] = [];

  setTimeout(ms: number): this {
    this.timeouts.push(ms);
    return this;
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close", false);
    }
    return this;
  }
}

function setup(maxFrameBytes = 1024) {
  const socket = new FakeSocket();
  const timer = new FakeTimer();
  const lines: Array<{ line: string; at: number }> = [];
  const events: string[] = [];
  let live = false;
  let overflowed = 0;
  const handlers: ControlConnectionHandlers = {
    onLine: (line, at) => lines.push({ line, at }),
    onOverflow: () => {
      overflowed++;
    },
    hasLiveRequest: () => live,
    onClose: (hadError) => events.push(`close:${hadError}`),
    onError: (error) => events.push(`error:${error.message}`),
    trace: (event) => events.push(event),
  };
  const connection = new ControlConnection(socket, "s1", timer, maxFrameBytes);
  connection.start(handlers);
  return {
    socket,
    timer,
    lines,
    events,
    connection,
    setLive: (v: boolean) => {
      live = v;
    },
    overflowed: () => overflowed,
  };
}

describe("ControlConnection", () => {
  test("arms the idle timeout on start and frames inbound lines with the chunk receive time", () => {
    const t = setup();
    expect(t.socket.timeouts).toEqual([DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS]);
    t.timer.advanceTime(50);
    t.socket.emit("data", Buffer.from('{"a":1}\n{"b":2}\n'));
    expect(t.lines.map((l) => l.line)).toEqual(['{"a":1}', '{"b":2}']);
    expect(t.lines.every((l) => l.at === t.timer.now())).toBe(true);
  });

  test("reports an oversized frame and ignores later bytes", () => {
    const t = setup(8);
    t.socket.emit("data", Buffer.from("123456789012"));
    expect(t.overflowed()).toBe(1);
    t.socket.emit("data", Buffer.from("x\n"));
    expect(t.lines).toEqual([]);
  });

  test("destroys a silent socket on idle timeout", () => {
    const t = setup();
    t.socket.emit("timeout");
    expect(t.socket.destroyed).toBe(true);
    expect(t.events).toContain("close:false");
  });

  test("renews the idle window while a live request exists and nothing is queued", () => {
    const t = setup();
    t.setLive(true);
    t.socket.emit("timeout");
    expect(t.socket.destroyed).toBe(false);
    expect(t.socket.timeouts.at(-1)).toBe(0);
    // The renewal runs on the injected timer, and fires the same check.
    t.setLive(false);
    t.timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
    expect(t.socket.destroyed).toBe(true);
  });

  test("does not renew when bytes are queued, even with a live request", () => {
    const t = setup();
    t.setLive(true);
    t.socket.writableLength = 10;
    t.socket.emit("timeout");
    expect(t.socket.destroyed).toBe(true);
  });

  test("a backpressured socket stops using Node's timeout and is reaped by the timer", () => {
    const t = setup();
    t.connection.startBackpressureIdle();
    expect(t.socket.timeouts.at(-1)).toBe(0);
    t.timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
    expect(t.socket.destroyed).toBe(true);
  });

  test("responseFlushed restores Node's timeout when no backpressure timer runs", () => {
    const t = setup();
    t.connection.responseFlushed();
    expect(t.socket.timeouts.at(-1)).toBe(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
  });

  test("destroys a peer-ended socket after the flush grace", () => {
    const t = setup();
    t.socket.emit("end");
    t.timer.advanceTime(DAEMON_RPC_SOCKET_PEER_END_FLUSH_GRACE_MS - 1);
    expect(t.socket.destroyed).toBe(false);
    t.timer.advanceTime(1);
    expect(t.socket.destroyed).toBe(true);
  });

  test("close cancels timers, disposes the guard and notifies the owner once", () => {
    const t = setup();
    t.connection.outboundWriteGuard();
    t.socket.emit("end");
    t.socket.emit("close", true);
    t.timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS * 2);
    expect(t.events.filter((e) => e.startsWith("close:"))).toEqual(["close:true"]);
    expect(t.events).toContain("socket_close");
    // After close the idle helpers are inert.
    const before = t.socket.timeouts.length;
    t.connection.responseFlushed();
    expect(t.socket.timeouts.length).toBe(before);
  });

  test("an expected peer-close error releases then destroys; others do too", () => {
    const t = setup();
    const error = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    expect(isExpectedPeerClose(error)).toBe(true);
    expect(isExpectedPeerClose(new Error("boom"))).toBe(false);
    t.socket.emit("error", error);
    expect(t.events[0]).toBe("error:reset");
    expect(t.socket.destroyed).toBe(true);
  });

  test("the outbound guard is created once per connection", () => {
    const t = setup();
    expect(t.connection.outboundWriteGuard()).toBe(t.connection.outboundWriteGuard());
  });
});
