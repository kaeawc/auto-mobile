import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonSocketReachability } from "../../src/daemon/daemonSocketReachability";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { BaseSocketServer } from "../../src/daemon/socketServer/BaseSocketServer";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { executionTracker } from "../../src/server/executionTracker";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  androidDevice,
  createFakeDaemonState,
  createFakeDeviceManager,
} from "./helpers/inputSocketHarness";

/**
 * Interactions between the control socket's incremental line framer (#10109) and the
 * `input/*` admission path (#10032 and the owner/gesture-registry fixes before it):
 * a frame the framer refuses must never have been admitted anywhere downstream, and a
 * connection that connects and leaves without sending (the incumbent-owner guard's
 * reachability probe, #10107) must not look like an overflow or keep any state.
 * Sockets, the CtrlProxy client and the device manager are in-memory fakes; nothing
 * spawns, binds or touches a daemon or database.
 */

const LIMIT = 512;

class FakeSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly responses: DaemonResponse[] = [];
  setTimeout(): this {
    return this;
  }
  write(data: string, callback?: (error?: Error | null) => void): boolean {
    if (this.destroyed) {
      throw Object.assign(new Error("peer closed"), { code: "EPIPE" });
    }
    this.responses.push(JSON.parse(data) as DaemonResponse);
    callback?.();
    return true;
  }
  end(): this {
    return this.destroy();
  }
  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close", false);
    }
    return this;
  }
  sendRaw(text: string): void {
    this.emit("data", Buffer.from(text));
  }
  send(request: DaemonRequest): void {
    this.sendRaw(`${JSON.stringify(request)}\n`);
  }
}

type Ack = { success: boolean; error?: string };

interface Recorded {
  label: string;
  args: unknown[];
  release: (result: Ack) => void;
}

interface Internals {
  acceptingRequests: boolean;
  maxInboundFrameBytes: number;
  handleConnection(socket: Socket): void;
  activeRequestHandlers: Set<Promise<void>>;
  ownedGestures: { ownerCount: number };
  sessions: Map<string, unknown>;
  clientSockets: Map<string, Socket>;
  pendingSocketRequests: Set<unknown>;
}

const device = { platform: "android", deviceId: androidDevice.deviceId };

const tapFrame = (id: string, padding = ""): DaemonRequest => ({
  id,
  type: "mcp_request",
  method: "input/tap",
  params: { ...device, x: 1, y: 2, ...(padding ? { padding } : {}) },
});

const gestureFrame = (
  id: string,
  method: string,
  gestureId: string,
  padding = "",
): DaemonRequest => ({
  id,
  type: "mcp_request",
  method,
  params: { ...device, gestureId, x: 3, y: 4, ...(padding ? { padding } : {}) },
});

/** Pads a frame past the lowered limit so the framer, not the handler, must refuse it. */
const padding = (): string => "p".repeat(LIMIT * 2);

let server: UnixSocketServer;
let internals: Internals;
let calls: Recorded[];
let sockets: FakeSocket[];
let baselineActive: number;

function pending(label: string): Recorded[] {
  return calls.filter((call) => call.label === label);
}

beforeEach(() => {
  calls = [];
  sockets = [];
  baselineActive = executionTracker.getActiveExecutionCount();
  PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
  const record = (label: string) => {
    return (...args: unknown[]) =>
      new Promise<Ack>((resolve) => {
        calls.push({ label, args, release: resolve });
      });
  };
  spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
    () =>
      ({
        getScreenScaleMetadata: () => null,
        requestTapCoordinates: record("tap"),
        requestGestureStart: record("gestureStart"),
        requestGestureEnd: record("gestureEnd"),
      }) as unknown as AndroidCtrlProxyClient,
  );
  server = new UnixSocketServer(
    "unused",
    "http://localhost:0/mcp",
    createFakeDaemonState(new Map()) as DaemonStateAccess,
    new FakeTimer(),
  );
  internals = server as unknown as Internals;
  internals.acceptingRequests = true;
  internals.maxInboundFrameBytes = LIMIT;
});

afterEach(() => {
  spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
  PlatformDeviceManagerFactory.reset();
  for (const socket of sockets) {
    socket.destroy();
  }
});

function connect(): FakeSocket {
  const socket = new FakeSocket();
  sockets.push(socket);
  internals.handleConnection(socket as unknown as Socket);
  return socket;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function drain(): Promise<void> {
  await settle();
  await Promise.all([...internals.activeRequestHandlers]);
}

function expectNothingAdmitted(): void {
  expect(calls).toEqual([]);
  expect(internals.activeRequestHandlers.size).toBe(0);
  expect(internals.ownedGestures.ownerCount).toBe(0);
  expect(executionTracker.getActiveExecutionCount()).toBe(baselineActive);
  expect(executionTracker.hasActiveDeviceExecutions(androidDevice.deviceId)).toBe(false);
}

function expectFrameTooLarge(socket: FakeSocket): void {
  expect(socket.destroyed).toBe(true);
  expect(socket.responses).toHaveLength(1);
  expect(socket.responses[0]).toMatchObject({
    id: null,
    success: false,
    error: "Invalid request: frame too large",
    code: -32600,
  });
  expect(internals.sessions.size).toBe(0);
  expect(internals.clientSockets.size).toBe(0);
}

describe("an over-limit input/* frame (#10109 x #10032 admission)", () => {
  test("a complete over-limit input/tap is refused without a tracked execution or device call", async () => {
    const socket = connect();

    socket.send(tapFrame("big-tap", padding()));
    await drain();

    expectFrameTooLarge(socket);
    expectNothingAdmitted();
  });

  test("an over-limit input/tap that never reaches its newline is refused before it is parsed", async () => {
    const socket = connect();
    const text = JSON.stringify(tapFrame("streamed-tap", padding()));

    for (let offset = 0; offset < text.length && !socket.destroyed; offset += 128) {
      socket.sendRaw(text.slice(offset, offset + 128));
    }
    await drain();

    expectFrameTooLarge(socket);
    expectNothingAdmitted();
  });

  test("an over-limit input/gestureStart never takes a gesture owner or reaches the device", async () => {
    const socket = connect();

    socket.send(gestureFrame("big-start", "input/gestureStart", "g-big", padding()));
    await drain();

    expectFrameTooLarge(socket);
    expectNothingAdmitted();
  });

  test("a frame at the limit is still admitted and tracked as before", async () => {
    const socket = connect();
    const bare = JSON.stringify(tapFrame("edge-tap", "x"));
    const fill = "x".repeat(LIMIT - Buffer.byteLength(bare) + 1);
    const frame = JSON.stringify(tapFrame("edge-tap", fill));
    expect(Buffer.byteLength(frame)).toBe(LIMIT);

    socket.sendRaw(`${frame}\n`);
    await settle();

    expect(socket.destroyed).toBe(false);
    expect(pending("tap")).toHaveLength(1);
    pending("tap")[0].release({ success: true });
    await drain();
    expect(socket.responses.find((response) => response.id === "edge-tap")).toMatchObject({
      success: true,
    });
    expect(executionTracker.getActiveExecutionCount()).toBe(baselineActive);
  });

  test("an overflow on the owning socket mid-gesture lifts the gesture once and leaves a sibling untouched", async () => {
    const owner = connect();
    const sibling = connect();
    owner.send(gestureFrame("start", "input/gestureStart", "g1"));
    await settle();
    pending("gestureStart")[0].release({ success: true });
    await settle();
    expect(internals.ownedGestures.ownerCount).toBe(1);

    owner.send(gestureFrame("move", "input/gestureMove", "g1", padding()));
    await settle();

    expect(owner.destroyed).toBe(true);
    expect(owner.responses.at(-1)).toMatchObject({
      id: null,
      success: false,
      error: "Invalid request: frame too large",
    });
    expect(pending("gestureEnd")).toHaveLength(1);
    expect(pending("gestureEnd")[0].args).toEqual(["g1", 0, 0, true, 5000]);
    pending("gestureEnd")[0].release({ success: true });
    await drain();
    expect(pending("gestureEnd")).toHaveLength(1);
    expect(pending("gestureMove")).toHaveLength(0);
    expect(internals.ownedGestures.ownerCount).toBe(0);

    expect(sibling.destroyed).toBe(false);
    sibling.send(tapFrame("sibling-tap"));
    await settle();
    expect(pending("tap")).toHaveLength(1);
    pending("tap")[0].release({ success: true });
    await drain();
    expect(sibling.responses.find((response) => response.id === "sibling-tap")).toMatchObject({
      success: true,
    });
    expect(executionTracker.getActiveExecutionCount()).toBe(baselineActive);
  });

  test("a valid tap that shares a chunk with an over-limit tail dies with the connection and leaves no execution", async () => {
    const socket = connect();
    const chunk = `${JSON.stringify(tapFrame("good-tap"))}\n${JSON.stringify(tapFrame("bad-tap", padding()))}\n`;

    socket.sendRaw(chunk);
    await drain();

    // The overflow destroys the socket in the same tick the first frame is admitted, so the
    // owner abort fence (#10006) stops it before dispatch: it gets no reply, like the tail.
    expect(socket.destroyed).toBe(true);
    expect(socket.responses).toHaveLength(1);
    expect(socket.responses[0]).toMatchObject({
      id: null,
      error: "Invalid request: frame too large",
    });
    expectNothingAdmitted();
  });
});

describe("a connect-and-leave probe against the control socket's framer (#10107 x #10109)", () => {
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;

  beforeEach(() => {
    warn = spyOn(logger, "warn");
  });

  afterEach(() => {
    warn.mockRestore();
  });

  function overflowWarnings(): string[] {
    return warn.mock.calls
      .map((args) => String(args[0]))
      .filter((message) => /bytes; rejecting|exceeded .* bytes/.test(message));
  }

  test("a probe that sends nothing and closes is not an overflow and keeps no session state", async () => {
    const probe = connect();
    expect(internals.clientSockets.size).toBe(1);

    probe.destroy();
    await drain();

    expect(overflowWarnings()).toEqual([]);
    expect(probe.responses).toEqual([]);
    expect(internals.sessions.size).toBe(0);
    expect(internals.clientSockets.size).toBe(0);
    expect(internals.pendingSocketRequests.size).toBe(0);
    expectNothingAdmitted();
  });

  test("many back-to-back probes leave no state behind and the next real client is served", async () => {
    for (let i = 0; i < 25; i++) {
      connect().destroy();
    }
    await drain();
    expect(internals.sessions.size).toBe(0);
    expect(internals.clientSockets.size).toBe(0);

    const client = connect();
    client.send(tapFrame("after-probes"));
    await settle();
    expect(pending("tap")).toHaveLength(1);
    pending("tap")[0].release({ success: true });
    await drain();

    expect(client.responses.find((response) => response.id === "after-probes")).toMatchObject({
      success: true,
    });
    expect(overflowWarnings()).toEqual([]);
  });

  test("a probe that leaves mid-frame discards the partial bytes without an overflow", async () => {
    const probe = connect();
    probe.sendRaw('{"id":"half","type":"mcp_request","method":"input/ta');

    probe.destroy();
    await drain();

    expect(overflowWarnings()).toEqual([]);
    expect(probe.responses).toEqual([]);
    expect(internals.clientSockets.size).toBe(0);
    expectNothingAdmitted();
  });
});

describe("the real reachability probe against a framer-backed server (#10107 x #10109)", () => {
  class ProbeTarget extends BaseSocketServer {
    readonly lines: string[] = [];
    connections = 0;
    closes = 0;
    protected readonly maxFrameBytes = LIMIT;
    protected async processLine(_socket: Socket, line: string): Promise<void> {
      this.lines.push(line);
    }
    protected onConnectionEstablished(): void {
      this.connections++;
    }
    protected onConnectionClose(): void {
      this.closes++;
    }
  }

  let dir: string;
  let target: ProbeTarget;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "framer-probe-"));
    target = new ProbeTarget(join(dir, "p.sock"), new FakeTimer(), "ProbeTarget", 0);
    await target.start();
  });

  afterEach(async () => {
    await target.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a reachable answer is not logged as a frame overflow and every probe connection closes", async () => {
    const warn = spyOn(logger, "warn");
    const reachability = new DaemonSocketReachability();

    for (let i = 0; i < 3; i++) {
      expect(await reachability.isReachable(target.getSocketPath(), 1_000)).toBe(true);
    }
    for (let i = 0; i < 50 && target.closes < 3; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(target.connections).toBe(3);
    expect(target.closes).toBe(3);
    expect(target.lines).toEqual([]);
    expect(
      warn.mock.calls.map((args) => String(args[0])).filter((m) => /exceeded/.test(m)),
    ).toEqual([]);
    warn.mockRestore();
  });
});
