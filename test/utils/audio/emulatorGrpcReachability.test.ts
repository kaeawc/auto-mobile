import { expect, test } from "bun:test";
import { NetEmulatorGrpcReachability } from "../../../src/utils/audio/emulatorGrpcReachability";
import { FakeGrpcProbeConnection } from "../../fakes/FakeGrpcProbeConnection";
import { FakeTimer } from "../../fakes/FakeTimer";

function harness() {
  const timer = new FakeTimer();
  const socket = new FakeGrpcProbeConnection();
  const addresses: { host: string; port: number }[] = [];
  const probe = new NetEmulatorGrpcReachability(timer, (port, host) => {
    addresses.push({ port, host });
    return socket;
  });
  return { probe, timer, socket, addresses };
}
test("TCP connection success closes the connection and clears its deadline", async () => {
  const h = harness();
  const result = h.probe.connect("localhost:8554", 500);
  h.socket.emit("connect");
  expect(await result).toEqual({ state: "reachable" });
  expect(h.addresses).toEqual([{ host: "localhost", port: 8554 }]);
  expect(h.socket.destroyed).toBe(true);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});
test("TCP refusal returns endpoint and error reason and closes the connection", async () => {
  const h = harness();
  const result = h.probe.connect("localhost:8554", 500);
  h.socket.emit("error", new Error("ECONNREFUSED"));
  expect(await result).toEqual({
    state: "unreachable",
    reason: expect.stringContaining("localhost:8554 did not accept a connection: ECONNREFUSED"),
  });
  expect(h.socket.destroyed).toBe(true);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});
test("TCP deadline closes a stalled connection without real time", async () => {
  const h = harness();
  const result = h.probe.connect("[::1]:8554", 500);
  h.timer.advanceTime(500);
  expect(await result).toEqual({
    state: "unreachable",
    reason: expect.stringContaining("timed out after 500ms"),
  });
  expect(h.addresses).toEqual([{ host: "::1", port: 8554 }]);
  expect(h.socket.destroyed).toBe(true);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});
