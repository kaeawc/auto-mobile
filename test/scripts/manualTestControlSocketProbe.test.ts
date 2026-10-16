import { expect, test } from "bun:test";
import {
  probeControlSocket,
  CONTROL_SOCKET_PROBE_METHOD,
} from "../../scripts/manual-test/controlSocketProbe";
import type { FrameConnection } from "../../scripts/manual-test/frameWire";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";
class ProbeConnection implements FrameConnection {
  ended = false;
  frames: Array<{ id: string; method: string }> = [];
  data: (chunk: Buffer) => void = () => {};
  close: (error?: Error) => void = () => {};
  success = true;
  silent = false;
  write(text: string): void {
    const frame = JSON.parse(text) as { id: string; method: string };
    this.frames.push(frame);
    if (!this.silent) {
      this.data(
        Buffer.from(
          `${JSON.stringify({ id: "wrong", success: true })}\n${JSON.stringify({ id: frame.id, success: this.success, result: { capabilities: [] } })}\n`,
        ),
      );
    }
  }
  onData(listener: (chunk: Buffer) => void): void {
    this.data = listener;
  }
  onClose(listener: (error?: Error) => void): void {
    this.close = listener;
  }
  end(): void {
    this.ended = true;
  }
  destroy(): void {
    this.ended = true;
  }
}
function fixture() {
  const connection = new ProbeConnection();
  const timer = new FakeTimer();
  const deps = { connect: async () => connection, timer, ids: new FakeIdGenerator() };
  return { connection, timer, deps };
}
test("probe matches one response and ends connection", async () => {
  const f = fixture();
  expect(await probeControlSocket("/fake/socket", f.deps)).toEqual({
    alive: true,
    result: { capabilities: [] },
  });
  expect(f.connection.frames).toEqual([
    { id: "fake-1", method: CONTROL_SOCKET_PROBE_METHOD, params: {}, type: "daemon_request" },
  ]);
  expect(f.connection.ended).toBe(true);
});
test("typed refusal still proves a live daemon", async () => {
  const f = fixture();
  f.connection.success = false;
  expect((await probeControlSocket("/fake/socket", f.deps)).alive).toBe(true);
  expect(f.connection.ended).toBe(true);
});
test("connect error is a diagnostic failure", async () => {
  const f = fixture();
  const result = await probeControlSocket("/fake/socket", {
    ...f.deps,
    connect: async () => {
      throw new Error("refused");
    },
  });
  expect(result).toEqual({ alive: false, reason: "refused" });
});
test("silent connection expires at FakeTimer deadline and ends", async () => {
  const f = fixture();
  f.connection.silent = true;
  const result = probeControlSocket("/fake/socket", f.deps, { timeoutMs: 40 });
  await drainUntilQuiescent(f.timer);
  f.timer.advanceTime(40);
  expect(await result).toEqual({ alive: false, reason: "Control socket probe timed out" });
  expect(f.connection.ended).toBe(true);
});
test("late connection after deadline ends without writing", async () => {
  const f = fixture();
  let connected: (value: FrameConnection) => void = () => {};
  const result = probeControlSocket(
    "/fake/socket",
    {
      ...f.deps,
      connect: () =>
        new Promise((done) => {
          connected = done;
        }),
    },
    { timeoutMs: 40 },
  );
  f.timer.advanceTime(40);
  expect((await result).alive).toBe(false);
  connected(f.connection);
  await drainUntilQuiescent(f.timer);
  expect(f.connection.ended).toBe(true);
  expect(f.connection.frames).toEqual([]);
});

test("oversized probe answer returns a bounded diagnostic failure", async () => {
  const f = fixture();
  f.connection.silent = true;
  const pending = probeControlSocket("/fake/socket", f.deps, { maxFrameBytes: 32 });
  await drainUntilQuiescent(f.timer);
  f.connection.data(Buffer.from("x".repeat(33)));
  expect(f.connection.ended).toBe(true);
  expect(await pending).toEqual({
    alive: false,
    reason: "Control probe response frame exceeds 32 bytes",
  });
  expect(f.timer.getPendingTimeoutCount()).toBe(0);
});

test("matching response before overflow in the same chunk proves the daemon alive", async () => {
  const f = fixture();
  f.connection.silent = true;
  const pending = probeControlSocket("/fake/socket", f.deps, { maxFrameBytes: 64 });
  await drainUntilQuiescent(f.timer);
  const line = JSON.stringify({ id: f.connection.frames[0].id, success: true, result: {} });
  f.connection.data(Buffer.from(line + "\n" + "x".repeat(65)));
  expect(await pending).toEqual({ alive: true, result: {} });
  expect(f.connection.ended).toBe(true);
  expect(f.timer.getPendingTimeoutCount()).toBe(0);
});

test("required broker capability must be advertised by a successful matching response", async () => {
  for (const [capabilities, success, alive] of [
    [["session-broker/v1"], true, true],
    [[], true, false],
    [["session-broker/v1"], false, false],
  ] as const) {
    const f = fixture();
    f.connection.write = (text) => {
      const frame = JSON.parse(text);
      f.connection.data(
        Buffer.from(JSON.stringify({ id: frame.id, success, result: { capabilities } }) + "\n"),
      );
    };
    const result = await probeControlSocket("/fake/socket", f.deps, {
      requireCapability: "session-broker/v1",
    });
    expect(result.alive).toBe(alive);
    if (!result.alive) {
      expect(result.reason).toContain("session-broker/v1");
    }
    expect(f.connection.ended).toBe(true);
  }
});
