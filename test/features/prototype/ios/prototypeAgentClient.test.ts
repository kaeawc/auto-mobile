import { describe, expect, test } from "bun:test";
import {
  connectPrototypeAgent,
  createPrototypeAgentLaunchConfig,
  PROTOTYPE_AGENT_PROTOCOL_VERSION,
  PROTOTYPE_AGENT_CLIENT_MAX_FRAME_BYTES,
  PrototypeAgentFrameTooLargeError,
  type PrototypeAgentClient,
} from "../../../../src/features/prototype/ios/prototypeAgentClient";
import { ActionableError } from "../../../../src/models/ActionableError";
import { CountingIdGenerator } from "../../../../src/utils/IdGenerator";
import {
  FakePrototypeAgentConnector,
  FakePrototypeAgentSocket,
} from "../../../fakes/FakePrototypeAgentSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";

const TOKEN = "launch-token-0123456789";
const PORT = 51_234;
const CAPABILITIES = [
  "show_prototype",
  "dismiss_prototype",
  "put_prototype_asset",
  "remove_prototype_asset",
  "get_prototype_status",
];

const helloResult = (overrides: Record<string, unknown> = {}) => ({
  type: "hello_result",
  agentVersion: "0.1.0",
  protocolVersion: PROTOTYPE_AGENT_PROTOCOL_VERSION,
  capabilities: CAPABILITIES,
  ...overrides,
});

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

function setup(maxFrameBytes?: number) {
  const socket = new FakePrototypeAgentSocket();
  const connector = new FakePrototypeAgentConnector(socket);
  const timer = new FakeTimer();
  const connecting = connectPrototypeAgent({
    port: PORT,
    token: TOKEN,
    connector,
    timer,
    maxFrameBytes,
    handshakeTimeoutMs: 1_000,
    requestTimeoutMs: 2_000,
  });
  return { socket, connector, timer, connecting };
}

async function connected(maxFrameBytes?: number): Promise<{
  socket: FakePrototypeAgentSocket;
  timer: FakeTimer;
  client: PrototypeAgentClient;
}> {
  const { socket, timer, connecting } = setup(maxFrameBytes);
  await flushMicrotasks();
  socket.push(helloResult());
  const client = await connecting;
  socket.written.length = 0;
  return { socket, timer, client };
}

describe("createPrototypeAgentLaunchConfig", () => {
  test("passes the host port and an IdGenerator token through SIMCTL_CHILD_ env", () => {
    const config = createPrototypeAgentLaunchConfig(PORT, new CountingIdGenerator("token"));
    expect(config).toEqual({
      port: PORT,
      token: "token-1",
      simctlEnvironment: {
        SIMCTL_CHILD_AUTOMOBILE_PROTOTYPE_PORT: "51234",
        SIMCTL_CHILD_AUTOMOBILE_PROTOTYPE_TOKEN: "token-1",
      },
    });
  });

  test("draws a fresh token per launch", () => {
    const ids = new CountingIdGenerator("token");
    expect(createPrototypeAgentLaunchConfig(PORT, ids).token).not.toBe(
      createPrototypeAgentLaunchConfig(PORT, ids).token,
    );
  });

  test("rejects ports outside 1..65535", () => {
    for (const port of [0, -1, 65_536, 1.5]) {
      expect(() => createPrototypeAgentLaunchConfig(port, new CountingIdGenerator())).toThrow(
        ActionableError,
      );
    }
  });
});

describe("connectPrototypeAgent handshake", () => {
  test("sends hello with the token first and resolves with the agent's versions", async () => {
    const { socket, connector, connecting } = setup();
    await flushMicrotasks();
    expect(connector.ports).toEqual([PORT]);
    expect(socket.frames()).toEqual([
      { type: "hello", token: TOKEN, protocolVersion: PROTOTYPE_AGENT_PROTOCOL_VERSION },
    ]);
    socket.push(helloResult());
    const client = await connecting;
    expect(client.handshake).toEqual({
      agentVersion: "0.1.0",
      protocolVersion: PROTOTYPE_AGENT_PROTOCOL_VERSION,
      capabilities: CAPABILITIES,
    });
  });

  test("refuses a protocol mismatch with an actionable error and closes", async () => {
    const { socket, connecting } = setup();
    await flushMicrotasks();
    socket.push(helloResult({ protocolVersion: PROTOTYPE_AGENT_PROTOCOL_VERSION + 1 }));
    const error = await connecting.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain(`speaks protocol ${PROTOTYPE_AGENT_PROTOCOL_VERSION + 1}`);
    expect(socket.ended).toBe(true);
  });

  test("treats a close before hello_result as a token rejection", async () => {
    const { socket, connecting } = setup();
    await flushMicrotasks();
    socket.closeFromAgent();
    const error = await connecting.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("auth token does not match");
  });

  test("rejects a reply that is not hello_result", async () => {
    const { socket, connecting } = setup();
    await flushMicrotasks();
    socket.push({ type: "prototype_result", requestId: "r1", success: true });
    await expect(connecting).rejects.toThrow("instead of hello_result");
    expect(socket.ended).toBe(true);
  });

  test("rejects malformed capabilities", async () => {
    const { socket, connecting } = setup();
    await flushMicrotasks();
    socket.push(helloResult({ capabilities: [1] }));
    await expect(connecting).rejects.toThrow("instead of hello_result");
  });

  test("times out on the injected timer when the agent stays silent", async () => {
    const { socket, timer, connecting } = setup();
    await flushMicrotasks();
    timer.advanceTime(1_000);
    await expect(connecting).rejects.toThrow("did not answer the handshake within 1000 ms");
    expect(socket.ended).toBe(true);
  });

  test("reports nothing listening as an actionable error", async () => {
    const connector = new FakePrototypeAgentConnector();
    connector.connectError = new Error("connect ECONNREFUSED 127.0.0.1:51234");
    const error = await connectPrototypeAgent({ port: PORT, token: TOKEN, connector }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("No prototype agent is listening on 127.0.0.1:51234");
  });

  test("handles hello_result split across chunks", async () => {
    const { socket, connecting } = setup();
    await flushMicrotasks();
    const line = `${JSON.stringify(helloResult())}\n`;
    socket.pushRaw(line.slice(0, 10));
    socket.pushRaw(line.slice(10));
    expect((await connecting).handshake.agentVersion).toBe("0.1.0");
  });
});

describe("PrototypeAgentClient after the handshake", () => {
  test("correlates prototype_result replies by requestId", async () => {
    const { socket, client } = await connected();
    const status = client.request("get_prototype_status");
    const show = client.request("show_prototype", { spec: { id: "a" } });
    const [first, second] = socket.frames();
    expect(first).toEqual({ type: "get_prototype_status", requestId: "r1" });
    expect(second).toEqual({ type: "show_prototype", requestId: "r2", spec: { id: "a" } });
    socket.push({ type: "prototype_result", requestId: "r2", success: true });
    socket.push({
      type: "prototype_result",
      requestId: "r1",
      success: true,
      status: { shown: false },
    });
    expect(await show).toEqual({ type: "prototype_result", requestId: "r2", success: true });
    expect((await status).status).toEqual({ shown: false });
  });

  test("a request body cannot override type or requestId", async () => {
    const { socket, client } = await connected();
    void client.request("dismiss_prototype", { type: "evil", requestId: "x", all: true });
    expect(socket.frames()).toEqual([{ type: "dismiss_prototype", requestId: "r1", all: true }]);
  });

  test("delivers prototype_event pushes to subscribers until they unsubscribe", async () => {
    const { socket, client } = await connected();
    const events: unknown[] = [];
    const unsubscribe = client.onEvent((event) => events.push(event));
    socket.push({ type: "prototype_event", kind: "emit", name: "liked", seq: 1 });
    unsubscribe();
    socket.push({ type: "prototype_event", kind: "emit", name: "liked", seq: 2 });
    expect(events).toEqual([{ type: "prototype_event", kind: "emit", name: "liked", seq: 1 }]);
  });

  test("refuses a request type the agent did not advertise", async () => {
    const { socket, timer, connecting } = setup();
    await flushMicrotasks();
    socket.push(helloResult({ capabilities: ["show_prototype"] }));
    const client = await connecting;
    await expect(client.request("put_prototype_asset", { id: "x" })).rejects.toThrow(
      "does not support put_prototype_asset",
    );
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("refuses the simulate_tap test hook unless the agent advertises it", async () => {
    const { client } = await connected();
    await expect(client.request("simulate_tap", { nodeId: "like-button" })).rejects.toThrow(
      "does not support simulate_tap",
    );
  });

  test("times a request out on the injected timer", async () => {
    const { timer, client } = await connected();
    const pending = client.request("get_prototype_status");
    timer.advanceTime(2_000);
    await expect(pending).rejects.toThrow("did not answer get_prototype_status within 2000 ms");
  });

  test("an agent close rejects pending requests and notifies once", async () => {
    const { socket, timer, client } = await connected();
    const closed: Error[] = [];
    client.onClosed((error) => closed.push(error));
    const pending = client.request("get_prototype_status");
    socket.closeFromAgent(new Error("ECONNRESET"));
    socket.closeFromAgent();
    await expect(pending).rejects.toThrow("the app may have exited (ECONNRESET)");
    expect(closed).toHaveLength(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    await expect(client.request("get_prototype_status")).rejects.toBe(closed[0]);
  });

  test("a non-JSON line from the agent fails the connection", async () => {
    const { socket, client } = await connected();
    const pending = client.request("get_prototype_status");
    socket.pushRaw("not json\n");
    await expect(pending).rejects.toThrow("not JSON");
    expect(socket.ended).toBe(true);
  });

  test("close ends the socket and rejects pending requests", async () => {
    const { socket, client } = await connected();
    const pending = client.request("get_prototype_status");
    client.close();
    await expect(pending).rejects.toThrow("closed by the host");
    expect(socket.ended).toBe(true);
  });
});

import { MAX_PROTOTYPE_SPEC_BYTES } from "../../../../src/features/prototype/prototypeSpec";

describe("prototype inbound frame bounds", () => {
  test("default is four times the spec byte budget", () => {
    expect(PROTOTYPE_AGENT_CLIENT_MAX_FRAME_BYTES).toBe(4 * MAX_PROTOTYPE_SPEC_BYTES);
  });
  test("overflow rejects all requests, closes once and ignores later chunks", async () => {
    const limit = Buffer.byteLength(JSON.stringify(helloResult()));
    const { socket, timer, client } = await connected(limit);
    const closed: Error[] = [],
      events: unknown[] = [];
    client.onClosed((error) => closed.push(error));
    client.onEvent((event) => events.push(event));
    const pending = client.request("get_prototype_status");
    const other = client.request("show_prototype");
    socket.pushRaw("é".repeat(Math.floor(limit / 2) + 1));
    expect(socket.ended).toBe(true);
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PrototypeAgentFrameTooLargeError);
    expect(error).toBeInstanceOf(ActionableError);
    expect((error as PrototypeAgentFrameTooLargeError).limitBytes).toBe(limit);
    await expect(other).rejects.toBe(error);
    await expect(client.request("get_prototype_status")).rejects.toBe(error);
    socket.push({ type: "prototype_event" });
    socket.closeFromAgent();
    expect(events).toEqual([]);
    expect(closed).toEqual([error as Error]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
  test("handshake overflow is a typed transport failure", async () => {
    const { socket, connecting, timer } = setup(32);
    await flushMicrotasks();
    socket.pushRaw("x".repeat(33));
    expect(socket.ended).toBe(true);
    await expect(connecting).rejects.toBeInstanceOf(PrototypeAgentFrameTooLargeError);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
  test("exact byte limit, split replies, blanks and batched events are accepted", async () => {
    const limit = Buffer.byteLength(JSON.stringify(helloResult()));
    const { socket, client } = await connected(limit);
    const pending = client.request("get_prototype_status");
    const reply = JSON.stringify({ type: "prototype_result", requestId: "r1", success: true });
    const padded = reply + " ".repeat(limit - Buffer.byteLength(reply));
    socket.pushRaw("\n \n" + padded.slice(0, 9));
    socket.pushRaw(padded.slice(9, 20));
    socket.pushRaw(padded.slice(20) + "\n");
    expect((await pending).success).toBe(true);
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));
    socket.pushRaw('{"type":"prototype_event","seq":1}\n{"type":"prototype_event","seq":2}\n');
    expect(events).toHaveLength(2);
    client.close();
  });
  test("a failing line prevents dispatch of a later line in the same chunk", async () => {
    const { socket, client } = await connected();
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));
    socket.pushRaw('bad json\n{"type":"prototype_event"}\n');
    expect(events).toEqual([]);
    expect(socket.ended).toBe(true);
  });
});
