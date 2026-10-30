import { expect, test } from "bun:test";
import { DaemonUnavailableError } from "../../src/daemon/client/client";
import { DaemonFrameTooLargeError } from "../../src/daemon/wire/DaemonFrameTooLargeError";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { InMemoryDaemonClient, SocketEnd } from "./inMemoryDaemonWire";

function pair() {
  const socket = new SocketEnd(),
    peer = new SocketEnd();
  socket.peer = peer;
  peer.peer = socket;
  return { socket, peer };
}
test("inbound overflow notifies once per socket and preserves the frame error", async () => {
  const { socket, peer } = pair();
  const timer = new FakeTimer();
  const client = new InMemoryDaemonClient(() => socket, timer, new CountingIdGenerator(), 32);
  await client.connect();
  let closed = 0;
  client.onConnectionClosed(() => closed++);
  const pending = client.callDaemonMethod("daemon/capabilities");
  peer.write("x".repeat(33));
  const error = await pending.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(DaemonFrameTooLargeError);
  expect(closed).toBe(1);
  expect(socket.destroyed).toBe(true);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});
test("peer close preserves request cause and reconnect guards each socket separately", async () => {
  let wire = pair();
  const timer = new FakeTimer();
  const client = new InMemoryDaemonClient(() => wire.socket, timer, new CountingIdGenerator(), 32);
  await client.connect();
  let closed = 0;
  client.onConnectionClosed(() => closed++);
  const pending = client.callDaemonMethod("daemon/capabilities");
  const oldSocket = wire.socket;
  wire.peer.destroy();
  const error = await pending.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(DaemonUnavailableError);
  expect((error as Error).message).toBe("Daemon socket connection lost: connection closed");
  expect((error as Error).cause).toBeDefined();
  expect(closed).toBe(1);
  wire = pair();
  await client.connect();
  oldSocket.emit("close");
  expect(client.liveSocket).toBe(wire.socket);
  const next = client.callDaemonMethod("daemon/capabilities");
  wire.peer.destroy();
  await expect(next).rejects.toBeInstanceOf(DaemonUnavailableError);
  expect(closed).toBe(2);
  wire.socket.emit("close");
  expect(closed).toBe(2);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});
