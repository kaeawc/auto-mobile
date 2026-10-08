import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD } from "../../src/daemon/constants";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { executionTracker } from "../../src/server/executionTracker";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  androidDevice,
  createFakeDaemonState,
  createFakeDeviceManager,
  createFakeSession,
} from "./helpers/inputSocketHarness";

/**
 * A desktop pane's taps, keys and swipes are the user using the device, so each completed
 * `input/*` frame must restart the idle window of the session that owns the device (owner
 * decision 2026-10-08: release 2 min after the last tool call). The socket server runs every
 * `input/*` handler through `runTrackedDeviceInput`, which starts an execution under the device
 * owner's UUID; its end is what the daemon turns into `recordToolCallEnded`. A stream subscription
 * alone (passive viewing) starts no execution and must not count.
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

const OWNER = "desktop-session";

let internals: Internals;
let sockets: FakeSocket[];
let ended: string[][];
let unsubscribe: () => void;

function useServer(ownerDevice: string): void {
  const session = createFakeSession(OWNER, ownerDevice, "android");
  const server = new UnixSocketServer(
    "unused",
    "http://localhost:0/mcp",
    createFakeDaemonState(new Map([[OWNER, session]])),
    new FakeTimer(),
  );
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

const ack = async () => ({ success: true });

beforeEach(() => {
  sockets = [];
  ended = [];
  PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
  spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
    () =>
      ({
        getScreenScaleMetadata: () => null,
        requestTapCoordinates: ack,
        requestSwipe: ack,
      }) as unknown as AndroidCtrlProxyClient,
  );
  unsubscribe = executionTracker.onSessionExecutionEnded((uuids) => {
    ended.push([...uuids]);
  });
});

afterEach(() => {
  unsubscribe();
  spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
  PlatformDeviceManagerFactory.reset();
  for (const socket of sockets) {
    socket.destroy();
  }
});

const tapFrame: DaemonRequest = {
  id: "tap",
  type: "mcp_request",
  method: "input/tap",
  params: { platform: "android", deviceId: androidDevice.deviceId, x: 1, y: 2 },
};

describe("desktop input/* counts as tool activity for the device's session", () => {
  test("a completed input/tap ends an execution under the owning session", async () => {
    useServer(androidDevice.deviceId);
    const socket = connect();

    socket.send(tapFrame);
    await drain();

    expect(socket.responses.find((frame) => frame.id === "tap")).toMatchObject({ success: true });
    expect(ended).toEqual([[OWNER]]);
  });

  test("an input/tap on a device no session owns restarts no session's idle window", async () => {
    useServer("emulator-other");
    const socket = connect();

    socket.send(tapFrame);
    await drain();

    expect(socket.responses.find((frame) => frame.id === "tap")).toMatchObject({ success: true });
    expect(ended).toEqual([]);
  });

  test("subscribing to the socket's notifications alone is not activity", async () => {
    useServer(androidDevice.deviceId);
    const socket = connect();

    socket.send({
      id: "subscribe",
      type: "mcp_request",
      method: DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD,
    });
    await drain();

    expect(ended).toEqual([]);
  });
});
