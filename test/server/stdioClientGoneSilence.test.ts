import { PassThrough } from "node:stream";
import { once } from "node:events";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { OutputGatedTransport } from "../../src/server/outputGatedTransport";
import { ProcessLifecycleHandlers, type ShutdownSignal } from "../../src/processLifecycle";
import { DaemonUnavailableError } from "../../src/daemon/client";
import { DAEMON_RELEASE_SESSION_METHOD, DAEMON_VERSION } from "../../src/daemon/constants";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeProcess } from "../fakes/FakeProcess";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../helpers/fakeTimerStepping";

type Message = Parameters<Transport["send"]>[0];

function createHarness() {
  const timer = new FakeTimer();
  const fakeProcess = new FakeProcess();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: Buffer[] = [];
  const logs: string[] = [];
  stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const gate = new OutputGatedTransport(new StdioServerTransport(stdin, stdout), (message) =>
    logs.push(message),
  );
  const release = Promise.withResolvers<unknown>();
  let holdRelease = false;
  let holdTool = false;
  const resource = Promise.withResolvers<never>();
  const client = new FakeDaemonClient({
    toolResultFor: (name) =>
      name === "getAndroid"
        ? {
            content: [
              {
                type: "text",
                text: JSON.stringify({ runtime: { session: { sessionUuid: "owned" } } }),
              },
            ],
          }
        : undefined,
    onCallTool: (name) =>
      name === "observe" && holdTool ? new Promise<never>(() => {}) : undefined,
    resourceResult: resource.promise,
    onCallDaemonMethod: (method) =>
      method === DAEMON_RELEASE_SESSION_METHOD && holdRelease ? release.promise : undefined,
  });
  const daemonManager = new FakeDaemonManager();
  daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
  const { server, proxy } = createProxyMcpServer({
    proxyConfig: {
      clientFactory: () => client,
      daemonManager,
      autoStartDaemon: false,
      daemonAvailabilityProbe: async () => true,
      idGenerator: new FakeIdGenerator(),
      timer,
    },
  });
  const lifecycle = new ProcessLifecycleHandlers(fakeProcess, timer);
  const shutdowns: ShutdownSignal[] = [];
  lifecycle.install();
  lifecycle.installStdinShutdownHandlers(stdin, () => gate.stopSending("stdin closed"));
  lifecycle.installStdoutShutdownHandler(stdout, () => gate.stopSending("stdout write failed"));
  lifecycle.setShutdownHandler(async (reason) => {
    shutdowns.push(reason);
    await proxy.close();
  });
  const byteCount = () => chunks.reduce((total, chunk) => total + chunk.length, 0);
  const messages = (): Message[] =>
    Buffer.concat(chunks)
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const request = (message: Message) => stdin.write(`${JSON.stringify(message)}\n`);
  const releases = () =>
    client.callDaemonMethodCalls.filter(({ method }) => method === DAEMON_RELEASE_SESSION_METHOD);
  return {
    stdin,
    stdout,
    gate,
    server,
    proxy,
    client,
    timer,
    fakeProcess,
    logs,
    shutdowns,
    byteCount,
    messages,
    request,
    releases,
    holdRelease: () => {
      holdRelease = true;
    },
    holdTool: () => {
      holdTool = true;
    },
    finishRelease: () => release.resolve({ released: true }),
  };
}

const rigs: ReturnType<typeof createHarness>[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    rig.finishRelease();
    await rig.proxy.close();
    await rig.server.close();
    rig.stdin.destroy();
    rig.stdout.destroy();
  }
});

async function connect() {
  const rig = createHarness();
  rigs.push(rig);
  await rig.server.connect(rig.gate);
  rig.request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "stdio-silence", version: "1" },
    },
  });
  await drainUntil(() => rig.messages().some((message) => "id" in message && message.id === 1), {
    description: "initialize response",
  });
  rig.request({ jsonrpc: "2.0", method: "notifications/initialized" });
  // Real acquisition-result handling owns this session; no hand-written heartbeat or DB.
  await rig.proxy.callTool("getAndroid", {});
  return rig;
}

async function eof(rig: Awaited<ReturnType<typeof connect>>) {
  const ended = once(rig.stdin, "end");
  const bytes = rig.byteCount();
  rig.stdin.end();
  await ended;
  return bytes;
}

async function exited(rig: Awaited<ReturnType<typeof connect>>) {
  await drainUntil(() => rig.fakeProcess.exitCodes.length > 0, {
    description: "stdio shutdown exit",
  });
  // The fake exit returns, so also expose answers still queued behind cleanup.
  await drainMicrotasks(128);
  expect(rig.fakeProcess.exitCodes).toEqual([0]);
  expect(rig.releases()).toHaveLength(1);
  expect(rig.releases()[0].params).toMatchObject({ sessionId: "owned" });
  expect(rig.client.isConnected()).toBe(false);
}

async function pendingTool(rig: Awaited<ReturnType<typeof connect>>) {
  rig.holdTool();
  rig.request({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "observe", arguments: {} },
  });
  await drainUntil(() => rig.client.callToolCalls.some(({ toolName }) => toolName === "observe"), {
    description: "in-flight daemon tool call",
  });
}

async function pendingResource(rig: Awaited<ReturnType<typeof connect>>) {
  rig.request({
    jsonrpc: "2.0",
    id: 2,
    method: "resources/read",
    params: { uri: "automobile:test" },
  });
  await drainUntil(() => rig.client.readResourceCalls.length === 1, {
    description: "in-flight daemon resource read",
  });
}

// Warm SDK request/error schemas and real proxy acquisition outside individual test durations.
beforeAll(async () => {
  for (const pendingRequest of [pendingTool, pendingResource]) {
    const rig = await connect();
    await pendingRequest(rig);
    await eof(rig);
    await exited(rig);
    await rig.server.close();
    rig.stdin.destroy();
    rig.stdout.destroy();
    rigs.splice(rigs.indexOf(rig), 1);
  }
});

describe("stdio client-gone silence (#11951)", () => {
  test("1: EOF drops the aborted in-flight tool result and still releases the session", async () => {
    const rig = await connect();
    await pendingTool(rig);
    const bytes = await eof(rig);
    await exited(rig);
    expect(rig.byteCount()).toBe(bytes);
    expect(rig.logs).toContain("[OutputGatedTransport] Dropped response: stdin closed");
    expect(rig.client.callToolSignals.at(-1)?.reason).toBeInstanceOf(DaemonUnavailableError);
  });

  test("2: EOF drops the aborted in-flight resource error and still releases the session", async () => {
    const rig = await connect();
    await pendingResource(rig);
    const bytes = await eof(rig);
    await exited(rig);
    expect(rig.byteCount()).toBe(bytes);
    expect(rig.logs).toContain("[OutputGatedTransport] Dropped response: stdin closed");
    expect(rig.client.readResourceSignals[0]?.reason).toBeInstanceOf(DaemonUnavailableError);
  });

  test("3: EOF drops both list-changed notifications during pending session release", async () => {
    const rig = await connect();
    rig.holdRelease();
    const bytes = await eof(rig);
    await drainUntil(() => rig.releases().length === 1, { description: "pending session release" });
    expect(rig.fakeProcess.exitCodes).toEqual([]);
    rig.client.emitNotification("notifications/tools/list_changed");
    rig.client.emitNotification("notifications/resources/list_changed");
    await drainMicrotasks(64);
    rig.finishRelease();
    await exited(rig);
    expect(rig.byteCount()).toBe(bytes);
    expect(rig.logs).toContain(
      "[OutputGatedTransport] Dropped notifications/tools/list_changed: stdin closed",
    );
    expect(rig.logs).toContain(
      "[OutputGatedTransport] Dropped notifications/resources/list_changed: stdin closed",
    );
  });

  test("4: idle EOF exits and releases the owned session without advancing fake time", async () => {
    const rig = await connect();
    const bytes = await eof(rig);
    await exited(rig);
    expect(rig.byteCount()).toBe(bytes);
    expect(rig.shutdowns).toEqual(["stdin"]);
    expect(rig.timer.now()).toBe(0);
  });

  test("5: open stdin writes a tool result and forwarded list-changed notifications", async () => {
    const rig = await connect();
    const bytes = rig.byteCount();
    rig.request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "observe", arguments: {} },
    });
    await drainUntil(() => rig.messages().some((message) => "id" in message && message.id === 2), {
      description: "tool result on stdout",
    });
    expect(rig.messages().find((message) => "id" in message && message.id === 2)).toMatchObject({
      result: { content: [{ type: "text", text: "success" }] },
    });
    const notificationStart = rig.messages().length;
    rig.client.emitNotification("notifications/tools/list_changed");
    rig.client.emitNotification("notifications/resources/list_changed");
    await drainUntil(
      () =>
        ["notifications/tools/list_changed", "notifications/resources/list_changed"].every(
          (method) =>
            rig
              .messages()
              .slice(notificationStart)
              .some((message) => "method" in message && message.method === method),
        ),
      { description: "forwarded list-changed notifications" },
    );
    expect(rig.byteCount()).toBeGreaterThan(bytes);
    await eof(rig);
    await exited(rig);
  });

  test("6: SIGTERM still writes the typed in-flight tool error before exit", async () => {
    const rig = await connect();
    await pendingTool(rig);
    rig.holdRelease();
    rig.fakeProcess.emit("SIGTERM");
    await drainUntil(() => rig.messages().some((message) => "id" in message && message.id === 2), {
      description: "signal-aborted tool result",
    });
    const answer = rig.messages().find((message) => "id" in message && message.id === 2);
    expect(answer).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(answer)).toContain("MCP proxy is closing");
    expect(rig.client.callToolSignals.at(-1)?.reason).toBeInstanceOf(DaemonUnavailableError);
    expect(rig.fakeProcess.exitCodes).toEqual([]);
    rig.finishRelease();
    await exited(rig);
    expect(rig.shutdowns).toEqual(["SIGTERM"]);
  });

  test("7: SIGTERM then EOF silences writes while the existing release remains pending", async () => {
    const rig = await connect();
    await pendingTool(rig);
    rig.holdRelease();
    rig.fakeProcess.emit("SIGTERM");
    await drainUntil(() => rig.releases().length === 1, { description: "signal shutdown release" });
    await drainUntil(() => rig.messages().some((message) => "id" in message && message.id === 2), {
      description: "tool answer while stdin remains open",
    });
    const bytes = await eof(rig);
    rig.client.emitNotification("notifications/tools/list_changed");
    rig.client.emitNotification("notifications/resources/list_changed");
    rig.finishRelease();
    await exited(rig);
    expect(rig.byteCount()).toBe(bytes);
    expect(rig.shutdowns).toEqual(["SIGTERM"]);
  });

  test("8: stdout EPIPE stops every later write and promptly exits without fake-time advance", async () => {
    const rig = await connect();
    await pendingTool(rig);
    const bytes = rig.byteCount();
    let writes = 0;
    const write = rig.stdout.write.bind(rig.stdout);
    rig.stdout.write = (...args: Parameters<typeof write>) => {
      writes++;
      return write(...args);
    };
    rig.stdout.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    rig.client.emitNotification("notifications/tools/list_changed");
    rig.client.emitNotification("notifications/resources/list_changed");
    await exited(rig);
    expect(rig.byteCount()).toBe(bytes);
    expect(writes).toBe(0);
    expect(rig.shutdowns).toEqual(["stdout"]);
    expect(rig.timer.now()).toBe(0);
  });
});
