import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { DaemonClient, DaemonUnavailableError } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { DaemonMcpProxy, DaemonToolOutcomeUnknownError } from "../../src/daemon/daemonMcpProxy";
import { DaemonFrameTooLargeError } from "../../src/daemon/socketServer/LineFramer";
import type { DaemonRequest } from "../../src/daemon/types";
import { logger } from "../../src/utils/logger";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntil, drainUntilQuiescent } from "../helpers/fakeTimerStepping";

const LIMIT = 512;
const SESSION = "android-session";
const result = { content: [{ type: "text", text: "ok" }] };

interface Wire {
  client: DaemonClient;
  socket: FakeSocket;
  requests: DaemonRequest[];
  answer(request: DaemonRequest, payload: unknown): void;
}
let proxy: DaemonMcpProxy;
let timer: FakeTimer;
let wires: Wire[];
let holdHeartbeat: boolean;
let spies: Array<ReturnType<typeof spyOn>>;

function makeWire(): Wire {
  const socket = new FakeSocket();
  const client = new DaemonClient(
    "in-memory://oversized-siblings",
    1_000,
    timer,
    {},
    null,
    new FakeIdGenerator(),
    "darwin",
    LIMIT,
  );
  client.attachSocketForTesting(socket);
  const requests: DaemonRequest[] = [];
  const answer = (request: DaemonRequest, payload: unknown) =>
    client.simulateIncomingDataForTesting(
      Buffer.from(
        JSON.stringify({ id: request.id, type: "mcp_response", success: true, result: payload }) +
          "\n",
      ),
    );
  spies.push(
    spyOn(socket, "write").mockImplementation((data) => {
      const request: DaemonRequest = JSON.parse(data.toString());
      requests.push(request);
      if (request.method === "tools/call") {
        if (request.params?.name === "getAndroid") {
          answer(request, {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  platform: "android",
                  runtime: { deviceId: "emulator-5554", session: { sessionUuid: SESSION } },
                }),
              },
            ],
          });
        } else if (wires.length > 1) {
          answer(request, result);
        }
      } else if (request.method !== "daemon/heartbeat" || !holdHeartbeat || wires.length > 1) {
        answer(request, request.method === "tools/list" ? { tools: [] } : {});
      }
      return true;
    }),
  );
  return { client, socket, requests, answer };
}

function setup(): void {
  timer = new FakeTimer();
  wires = [];
  holdHeartbeat = false;
  spies = [
    spyOn(logger, "info").mockImplementation(() => {}),
    spyOn(logger, "warn").mockImplementation(() => {}),
    spyOn(logger, "error").mockImplementation(() => {}),
  ];
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  proxy = new DaemonMcpProxy({
    clientFactory: () => {
      const wire = makeWire();
      wires.push(wire);
      return wire.client;
    },
    daemonAvailabilityProbe: async () => true,
    daemonManager: manager,
    autoStartDaemon: false,
    timer,
    idGenerator: new FakeIdGenerator(),
    heartbeatIntervalMs: 2_000,
    heartbeatTimeoutMs: 10_000,
  });
}
async function teardown(): Promise<void> {
  await proxy.close();
  for (const spy of spies) {
    spy.mockRestore();
  }
}
beforeAll(async () => {
  setup();
  try {
    await proxy.callTool("getAndroid", {});
  } finally {
    await teardown();
  }
});
beforeEach(setup);
afterEach(teardown);

const toolRequests = (name: string) =>
  wires.flatMap((wire) =>
    wire.requests.filter(
      (request) => request.method === "tools/call" && request.params?.name === name,
    ),
  );
async function sent(name: string): Promise<DaemonRequest> {
  await drainUntil(() => toolRequests(name).length > 0, { description: `${name} frame written` });
  return toolRequests(name)[0]!;
}
function overflow(request: DaemonRequest): void {
  wires[0]!.answer(request, "x".repeat(LIMIT + 1));
}
const failure = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);

for (const sibling of ["tapOn", "listDevices"] as const) {
  test(`oversized owner keeps its frame error and ${sibling} sibling follows ordinary connection-loss policy`, async () => {
    await proxy.listTools();
    const owner = failure(proxy.callTool("observe", {}));
    const other = failure(proxy.callTool(sibling, {}));
    const ownerRequest = await sent("observe");
    await sent(sibling);
    overflow(ownerRequest);
    const ownerError = await owner;
    expect(ownerError).toBeInstanceOf(DaemonFrameTooLargeError);
    const otherAnswer = await other;
    if (sibling === "tapOn") {
      expect(otherAnswer).toBeInstanceOf(DaemonToolOutcomeUnknownError);
      expect(otherAnswer).toMatchObject({
        toolName: "tapOn",
        cause: {
          name: "DaemonUnavailableError",
          cause: ownerError,
        },
      });
      expect(toolRequests(sibling)).toHaveLength(1);
    } else {
      expect(otherAnswer).toEqual(result);
      expect(toolRequests(sibling)).toHaveLength(2);
    }
    expect(toolRequests("observe")).toHaveLength(1);
    expect(wires[0]!.socket.destroyed).toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
}

test("an in-flight keeper heartbeat sibling reconnects and continues its held session", async () => {
  await proxy.callTool("getAndroid", {});
  holdHeartbeat = true;
  const wire = wires[0]!;
  const heartbeatFailure: unknown[] = [];
  const callDaemonMethod = wire.client.callDaemonMethod.bind(wire.client);
  spies.push(
    spyOn(wire.client, "callDaemonMethod").mockImplementation((...args) =>
      callDaemonMethod(...args).catch((error: unknown) => {
        heartbeatFailure.push(error);
        throw error;
      }),
    ),
  );
  timer.advanceTime(2_000);
  await drainUntil(
    () => wire.requests.filter((request) => request.method === "daemon/heartbeat").length === 2,
    { description: "keeper heartbeat frame written" },
  );
  const heartbeat = wire.requests.at(-1)!;
  const owner = failure(proxy.callTool("observe", {}));
  const request = await sent("observe");
  overflow(request);
  const ownerError = await owner;
  expect(ownerError).toBeInstanceOf(DaemonFrameTooLargeError);
  await drainUntilQuiescent(timer);
  expect(heartbeatFailure).toHaveLength(1);
  expect(heartbeatFailure[0]).toBeInstanceOf(DaemonUnavailableError);
  expect(heartbeatFailure[0]).toMatchObject({ cause: ownerError });
  expect(wire.client.hasPendingRequestForTesting(heartbeat.id)).toBe(false);
  expect(wires.length).toBe(2);
  expect(
    wires[1]!.requests.some(
      (frame) => frame.method === "daemon/heartbeat" && frame.params?.sessionId === SESSION,
    ),
  ).toBe(true);
  holdHeartbeat = false;
  await timer.advanceTimeAsync(2_000, () => drainUntilQuiescent(timer));
  expect(
    wires[1]!.requests.filter((frame) => frame.method === "daemon/heartbeat").length,
  ).toBeGreaterThan(1);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});
