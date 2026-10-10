import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ManagedConnectionBinding } from "../../src/daemon/managedSlots/managedConnectionScope";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  androidDevice,
  createFakeDaemonState,
  createFakeDeviceManager,
  createFakeSession,
} from "./helpers/inputSocketHarness";

/**
 * #11178: `input/*` frames are control. A socket bound to managed slots drives only its own slot
 * devices; the binding ends with the socket. Generic sockets are unaffected by this gate.
 */

class FakeSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly responses: DaemonResponse[] = [];
  setTimeout(): this {
    return this;
  }
  write(data: string, callback?: (error?: Error | null) => void): boolean {
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
  send(request: DaemonRequest): void {
    this.emit("data", Buffer.from(`${JSON.stringify(request)}\n`));
  }
}

interface Internals {
  acceptingRequests: boolean;
  handleConnection(socket: Socket): void;
  activeRequestHandlers: Set<Promise<void>>;
}

const SLOT_SESSION = "slot-exec";

let internals: Internals;
let sockets: FakeSocket[];
let binding: ManagedConnectionBinding | undefined;
let unbound: string[];

function useServer(): void {
  const session = createFakeSession(SLOT_SESSION, androidDevice.deviceId, "android");
  const state = {
    ...createFakeDaemonState(new Map([[SLOT_SESSION, session]])),
    getManagedConnectionScopes: () => ({
      get: (mcpSessionId: string | undefined) => (mcpSessionId ? binding : undefined),
      unbind: (mcpSessionId: string) => {
        unbound.push(mcpSessionId);
      },
    }),
  };
  const server = new UnixSocketServer("unused", "http://localhost:0/mcp", state, new FakeTimer());
  internals = server as unknown as Internals;
  internals.acceptingRequests = true;
}

function connect(): FakeSocket {
  const socket = new FakeSocket();
  sockets.push(socket);
  internals.handleConnection(socket as unknown as Socket);
  return socket;
}

async function drain(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await Promise.all([...internals.activeRequestHandlers]);
}

function tap(id: string): DaemonRequest {
  return {
    id,
    type: "mcp_request",
    method: "input/tap",
    params: {
      platform: "android",
      deviceId: androidDevice.deviceId,
      x: 1,
      y: 2,
      sessionUuid: SLOT_SESSION,
    },
  };
}

const ack = async () => ({ success: true });

beforeEach(() => {
  sockets = [];
  unbound = [];
  binding = undefined;
  PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
  spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
    () =>
      ({
        getScreenScaleMetadata: () => null,
        requestTapCoordinates: ack,
      }) as unknown as AndroidCtrlProxyClient,
  );
});

afterEach(() => {
  spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
  PlatformDeviceManagerFactory.reset();
  for (const socket of sockets) {
    socket.destroy();
  }
});

describe("input/* from a managed connection (#11178)", () => {
  test("a managed socket drives its own slot device", async () => {
    binding = { scopeKey: "scope-a", sessionUuids: new Set([SLOT_SESSION]) };
    useServer();
    const socket = connect();

    socket.send(tap("own"));
    await drain();

    expect(socket.responses.find((frame) => frame.id === "own")).toMatchObject({ success: true });
  });

  test("a managed socket may not drive a device outside its slots", async () => {
    binding = { scopeKey: "scope-a", sessionUuids: new Set(["another-slot-exec"]) };
    useServer();
    const socket = connect();

    socket.send(tap("foreign"));
    await drain();

    expect(socket.responses.find((frame) => frame.id === "foreign")).toMatchObject({
      success: false,
      code: "device_outside_managed_slots",
    });
  });

  test("a generic socket is not confined, and the binding ends with the socket", async () => {
    useServer();
    const socket = connect();

    socket.send(tap("generic"));
    await drain();
    expect(socket.responses.find((frame) => frame.id === "generic")).toMatchObject({
      success: true,
    });

    socket.destroy();
    expect(unbound).toHaveLength(1);
  });
});
