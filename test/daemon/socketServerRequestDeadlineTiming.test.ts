import { createTestUnixSocketServer } from "../helpers/createTestUnixSocketServer";
import { Socket } from "node:net";
import { expect, spyOn, test } from "bun:test";
import type { DaemonRequest } from "../../src/daemon/types";
import {
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  MAX_PROGRESS_EXTENDED_MCP_REQUEST_TIMEOUT_MS,
} from "../../src/daemon/mcpRequestTimeout";
import { DAEMON_CANCEL_REQUEST_METHOD } from "../../src/daemon/constants";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Behaviour pin for #11817: what deadline and abort signal a control-socket request carries from
 * frame parse through admission. Guards the move to one shared request context so the budget,
 * its anchor (frame receipt, not admission) and cancellation timing stay identical.
 */

type Server = ReturnType<typeof createTestUnixSocketServer>;

interface Harness {
  timer: FakeTimer;
  socket: Socket;
  server: Server;
  seen: Array<{ signal?: AbortSignal; receivedAtMs?: number }>;
  release: () => void;
}

function harness(): Harness {
  const timer = new FakeTimer();
  // A real, unconnected socket: no fd, so nothing is opened; writes are swallowed.
  const socket = new Socket();
  spyOn(socket, "write").mockImplementation(() => true);
  const server = createTestUnixSocketServer("unused", "http://localhost:0/mcp", undefined, timer);
  // Bracket access is TypeScript's sanctioned way to reach private members from a test.
  server["acceptingRequests"] = true;
  server["handleConnection"](socket);
  const gate = Promise.withResolvers<unknown>();
  const seen: Harness["seen"] = [];
  server["handleLocalSocketRequest"] = (_request, _sessionId, signal, receivedAtMs) => {
    seen.push({ signal, receivedAtMs });
    return gate.promise;
  };
  return { timer, socket, server, seen, release: () => gate.resolve({}) };
}

function send(socket: Socket, request: Omit<DaemonRequest, "type">): void {
  socket.emit("data", Buffer.from(JSON.stringify({ type: "mcp_request", ...request }) + "\n"));
}

const tap = (id: string, timeoutMs?: number): Omit<DaemonRequest, "type"> => ({
  id,
  method: "input/tap",
  params: { platform: "android", deviceId: "emulator-5554", x: 1, y: 2 },
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
});

async function settle(): Promise<void> {
  for (let index = 0; index < 30; index++) {
    await Promise.resolve();
  }
}

function pendingFor(h: Harness, id: string) {
  const found = [...h.server["pendingSocketRequests"]].find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`no pending request ${id}`);
  }
  return found;
}

test("the deadline is anchored at frame receipt and keeps its value after admission", async () => {
  const h = harness();
  h.timer.advanceTime(1_000);
  send(h.socket, tap("a", 5_000));
  const atParse = pendingFor(h, "a").idleDeadline;
  expect(atParse?.value).toBe(6_000);
  await settle();
  h.timer.advanceTime(2_000);
  const admitted = pendingFor(h, "a").idleDeadline;
  expect(admitted?.value).toBe(6_000);
  // One deadline for the whole request: admission reuses the object built at frame parse.
  expect(admitted).toBe(atParse);
  expect(admitted?.ceiling).toBe(1_000 + MAX_PROGRESS_EXTENDED_MCP_REQUEST_TIMEOUT_MS);
  expect(h.seen).toHaveLength(1);
  expect(h.seen[0]?.receivedAtMs).toBe(1_000);
  h.release();
  await settle();
});

test("a frame without timeoutMs gets the default budget", async () => {
  const h = harness();
  send(h.socket, tap("d"));
  await settle();
  expect(pendingFor(h, "d").idleDeadline?.value).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
  h.release();
  await settle();
});

test("progress extends the admitted deadline up to its ceiling and never shortens it", async () => {
  const h = harness();
  send(h.socket, tap("p", 5_000));
  await settle();
  const deadline = pendingFor(h, "p").idleDeadline!;
  h.timer.advanceTime(4_000);
  deadline.extendOnProgress(h.timer.now(), 5_000);
  expect(deadline.value).toBe(9_000);
  deadline.extendOnProgress(h.timer.now(), 1_000);
  expect(deadline.value).toBe(9_000);
  h.timer.advanceTime(1_000_000);
  deadline.extendOnProgress(h.timer.now(), 5_000);
  expect(deadline.value).toBe(deadline.ceiling);
  h.release();
  await settle();
});

test("a client cancel frame aborts the in-flight request's signal", async () => {
  const h = harness();
  send(h.socket, tap("c", 5_000));
  await settle();
  const signal = h.seen[0]?.signal;
  expect(signal?.aborted).toBe(false);
  send(h.socket, {
    id: "cancel-1",
    method: DAEMON_CANCEL_REQUEST_METHOD,
    params: { requestId: "c" },
  });
  await settle();
  expect(signal?.aborted).toBe(true);
  h.release();
  await settle();
});

test("closing the owner socket aborts the in-flight request's signal", async () => {
  const h = harness();
  send(h.socket, tap("x", 5_000));
  await settle();
  const signal = h.seen[0]?.signal;
  expect(signal?.aborted).toBe(false);
  h.socket.destroy();
  // A real socket emits "close" on the next tick, not synchronously.
  await new Promise<void>((resolve) => process.nextTick(resolve));
  await settle();
  expect(signal?.aborted).toBe(true);
  h.release();
  await settle();
});
