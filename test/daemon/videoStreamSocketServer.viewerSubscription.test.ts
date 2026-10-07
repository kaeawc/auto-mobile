import { createDeviceCaptureRegistry } from "../../src/features/webrtc/deviceCaptureRegistry";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  VideoStreamSocketServer,
  type DeviceOwnershipChanges,
} from "../../src/daemon/videoStreamSocketServer";
import { BaseSocketServer } from "../../src/daemon/socketServer/BaseSocketServer";
import {
  SessionScopedStreamAuthenticator,
  type StreamSocketAuthenticator,
} from "../../src/daemon/streamSocketAuth";
import { DaemonState } from "../../src/daemon/daemonState";
import { releasingSessionHarness } from "../helpers/releasingSessionHarness";
import { StreamDeviceLifecycleEmitter } from "../../src/daemon/streamDeviceLifecycleEvents";
import { assertMayControl, ViewerReadOnlyError } from "../../src/daemon/streamSubscriptionPolicy";
import { encodeSubscriptionNotice } from "../../src/daemon/videoStreamFraming";
import type { VideoStreamSocketResponse } from "../../src/daemon/videoStreamSocketTypes";
import type { H264CaptureSource } from "../../src/features/webrtc/H264CaptureSource";
import type { BootedDevice } from "../../src/models";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

const device = { deviceId: "fake-device", platform: "android", name: "Fake" } as BootedDevice;
class TestServer extends VideoStreamSocketServer {
  accept(socket: FakeSocket): void {
    this.handleConnection(socket);
  }
  line(socket: FakeSocket, request: unknown): Promise<void> {
    return this.processLine(socket, JSON.stringify(request));
  }
}
// Models Bun leaving end() pending when terminal writes cannot drain to a disconnected peer.
class PendingEndSocket extends FakeSocket {
  endCalls = 0;
  override end(): void {
    this.endCalls++;
  }
}
class NonReadingSocket extends PendingEndSocket {
  override write(data: string | Buffer): boolean {
    super.write(data);
    return false;
  }
  override destroySoon(): void {
    this.end();
  }
}
class Source implements H264CaptureSource {
  stopped = false;
  stopGate?: Promise<void>;
  onStop = () => {};
  consumerStates: boolean[] = [];
  constructor(private readonly startGate?: Promise<void>) {}
  async start(): Promise<void> {
    await this.startGate;
  }
  async stop(): Promise<void> {
    this.onStop();
    await this.stopGate;
    this.stopped = true;
  }
  requestKeyFrame(): boolean {
    return true;
  }
  setHasConsumers(value: boolean): void {
    this.consumerStates.push(value);
  }
}
class Ownership implements DeviceOwnershipChanges {
  listeners = new Set<(id: string) => void>();
  onDeviceOwnershipChange(cb: (id: string) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
  changed(): void {
    for (const cb of this.listeners) {
      cb(device.deviceId);
    }
  }
}
function messages(socket: FakeSocket): VideoStreamSocketResponse[] {
  return socket.written
    .filter((item): item is string => typeof item === "string")
    .map((item) => JSON.parse(item));
}
function binary(socket: FakeSocket): Buffer[] {
  return socket.written.filter((item): item is Buffer => Buffer.isBuffer(item));
}
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}
const servers: TestServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});
async function harness(
  options: {
    owner?: string | null;
    authOff?: boolean;
    authenticator?: StreamSocketAuthenticator;
    useDefaultAuthenticator?: boolean;
    startGate?: Promise<void>;
    resolveGate?: Promise<void>;
    onResolve?: (platform?: "android" | "ios") => void;
    outboundStallTimeoutMs?: number;
  } = {},
) {
  const timer = new FakeTimer();
  const ownership = new Ownership();
  const lifecycle = new StreamDeviceLifecycleEmitter();
  const state = {
    owner: options.owner ?? null,
    live: new Set(["a", "b"]),
    releasing: false,
    quarantined: false,
  };
  const session = {};
  const sources: Source[] = [];
  const hints: Array<{ quality?: string; fps?: number; bitrateBps?: number }> = [];
  const emissions: Array<(data: Buffer) => void> = [];
  let lifecycleListeners = 0;
  const releaseListeners = new Set<(sessionId: string) => void>();
  let resolveCalls = 0;
  const server = new TestServer(
    {
      resolveDevice: async (_deviceId, platform) => {
        options.onResolve?.(platform);
        resolveCalls++;
        await options.resolveGate;
        return device;
      },
      captureRegistry: createDeviceCaptureRegistry(),
      createCaptureSource: async (opts) => {
        hints.push(opts);
        emissions.push(opts.onData);
        const source = new Source(options.startGate);
        sources.push(source);
        return source;
      },
      nowUs: () => 1000n,
      outboundStallTimeoutMs: options.outboundStallTimeoutMs,
      ownershipChanges: () => ownership,
      sessionReleases: {
        subscribe: (cb) => {
          releaseListeners.add(cb);
          return () => {
            releaseListeners.delete(cb);
          };
        },
      },
      deviceLifecycle: () => ({
        onDeviceRestored: (cb) => {
          lifecycleListeners++;
          const remove = lifecycle.onDeviceRestored(cb);
          return () => {
            lifecycleListeners--;
            remove();
          };
        },
        onDeviceRemoved: (cb) => {
          lifecycleListeners++;
          const remove = lifecycle.onDeviceRemoved(cb);
          return () => {
            lifecycleListeners--;
            remove();
          };
        },
        onDeviceIdentityChanged: (cb) => {
          lifecycleListeners++;
          const remove = lifecycle.onDeviceIdentityChanged(cb);
          return () => {
            lifecycleListeners--;
            remove();
          };
        },
      }),
    },
    "/unused/viewer.sock",
    timer,
    options.useDefaultAuthenticator
      ? undefined
      : (options.authenticator ??
          new SessionScopedStreamAuthenticator(
            () => ({
              getSession: (id) => (state.live.has(id) ? session : null),
              getReleasingSession: () => (state.releasing ? session : null),
              getSessionForDevice: () => state.owner,
              getDeviceLabels: () => undefined,
            }),
            "video-stream subscribe",
            options.authOff ? { AUTOMOBILE_DAEMON_STREAM_AUTH: "0" } : {},
          )),
    {
      assertDeviceActionable: () => {
        if (state.quarantined) {
          throw new Error("quarantined");
        }
      },
    },
  );
  servers.push(server);
  // Only bypass the base's real bind; exercise the relay's start/listener wiring.
  const bind = spyOn(BaseSocketServer.prototype, "start").mockResolvedValue(undefined);
  try {
    await server.start();
  } finally {
    bind.mockRestore();
  }
  const subscribe = async (id = "a", extra: Record<string, unknown> = {}) => {
    const socket = new FakeSocket();
    await server.line(socket, {
      action: "subscribe",
      sessionUuid: id,
      deviceId: device.deviceId,
      ...extra,
    });
    return socket;
  };
  return {
    server,
    timer,
    resolveCalls: () => resolveCalls,
    ownership,
    lifecycle,
    state,
    sources,
    hints,
    subscribe,
    releaseListeners,
    released: (id: string) => {
      for (const cb of releaseListeners) {
        cb(id);
      }
    },
    lifecycleListenerCount: () => lifecycleListeners,
    emit: () =>
      emissions[0](
        Buffer.from([0, 0, 0, 1, 7, 1, 0, 0, 0, 1, 8, 1, 0, 0, 0, 1, 5, 1, 0, 0, 0, 1, 1, 1]),
      ),
  };
}
function terminal(socket: FakeSocket, reason: string): void {
  expect(messages(socket).at(-1)).toMatchObject({
    success: false,
    action: "unsubscribe",
    terminal: true,
    reason,
  });
  expect(messages(socket).at(-1)?.error).toStartWith("Video stream ended:");
  expect(socket.destroyed).toBe(true);
}

describe("viewer subscriptions (moved from real-socket ownership tests)", () => {
  test("shutdown bounds a non-reading connection without finish or peer FIN", async () => {
    const h = await harness({ outboundStallTimeoutMs: 50 });
    const socket = new NonReadingSocket();
    h.server.accept(socket);
    await h.server.line(socket, {
      action: "subscribe",
      sessionUuid: "a",
      deviceId: device.deviceId,
    });
    // Model server.close waiting for its final transport; no real listener/socket is opened.
    const transportClosed = new Promise<void>((resolve) => socket.once("close", resolve));
    const baseClose = spyOn(BaseSocketServer.prototype, "close").mockImplementation(
      () => transportClosed,
    );
    let completed = false;
    const closing = h.server.close().then(() => {
      completed = true;
    });
    try {
      await flush();
      expect(completed).toBe(false);
      expect(Reflect.get(h.server, "outboundStalls").size).toBe(0);
      h.timer.advanceTime(49);
      expect(socket.destroyed).toBe(false);
      h.timer.advanceTime(1);
      expect(socket.destroyed).toBe(true);
      await closing;
      expect(completed).toBe(true);
      expect(Reflect.get(h.server, "endingSockets").size).toBe(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      socket.destroy();
      await closing;
      baseClose.mockRestore();
    }
  });
  test.each([
    "device_removed",
    "identity_quarantined",
    "session_ended",
    "downgrade_then_end",
    "pending_removed",
  ] as const)(
    "ending %s retains a non-reading subscriber's destroy bound after detach",
    async (event) => {
      let release = () => {};
      const startGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = await harness({
        owner: "a",
        outboundStallTimeoutMs: 50,
        startGate: event === "pending_removed" ? startGate : undefined,
      });
      const socket = new NonReadingSocket();
      h.server.accept(socket);
      const joining = h.server.line(socket, {
        action: "subscribe",
        sessionUuid: "a",
        deviceId: device.deviceId,
      });
      try {
        await flush();
        if (event !== "pending_removed") {
          await joining;
          h.emit();
          expect(Reflect.get(h.server, "outboundStalls").has(socket)).toBe(true);
        }
        if (event === "identity_quarantined") {
          h.state.quarantined = true;
          h.lifecycle.deviceIdentityChanged(device.deviceId);
        } else if (event === "session_ended" || event === "downgrade_then_end") {
          if (event === "downgrade_then_end") {
            h.state.owner = "b";
            h.ownership.changed();
          }
          h.state.live.delete("a");
          h.released("a");
        } else {
          h.lifecycle.deviceRemoved(device.deviceId);
        }
        expect(messages(socket).at(-1)).toMatchObject({
          terminal: true,
          reason:
            event === "pending_removed"
              ? "device_removed"
              : event === "downgrade_then_end"
                ? "session_ended"
                : event,
        });
        expect(Reflect.get(h.server, "outboundStalls").has(socket)).toBe(false);
        h.timer.advanceTime(49);
        expect(socket.destroyed).toBe(false);
        h.timer.advanceTime(1);
        expect(socket.destroyed).toBe(true);
        expect(Reflect.get(h.server, "endingSockets").size).toBe(0);
      } finally {
        release();
        await joining;
        socket.destroy();
      }
    },
  );
  test.each(["pending_stop", "startup_without_event"] as const)(
    "quarantine during %s ends before ack or binary header",
    async (window) => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = await harness({ startGate: window === "startup_without_event" ? gate : undefined });
      if (window === "pending_stop") {
        const old = await h.subscribe();
        h.sources[0].stopGate = gate;
        old.destroy();
        // line() bypasses connection wiring, so explicitly deliver the fake disconnect.
        Reflect.get(h.server, "onConnectionClose").call(h.server, old);
        h.timer.advanceTime(3000);
        await flush();
        expect(h.server.activeDeviceIds()).toEqual([]);
      }
      const socket = new FakeSocket();
      const joining = h.server.line(socket, {
        action: "subscribe",
        sessionUuid: "a",
        deviceId: device.deviceId,
      });
      try {
        await flush();
        expect(messages(socket)).toHaveLength(0);
        h.state.quarantined = true;
        if (window === "pending_stop") {
          h.lifecycle.deviceIdentityChanged(device.deviceId);
        }
        release();
        await joining;
        terminal(socket, "identity_quarantined");
        expect(messages(socket)).toHaveLength(1);
        expect(binary(socket)).toHaveLength(0);
        expect(h.sources).toHaveLength(1);
        expect(h.server.subscriberCount(device.deviceId)).toBe(0);
        h.timer.advanceTime(3000);
        await flush();
        expect(h.sources[0].stopped).toBe(true);
      } finally {
        release();
        await joining;
      }
    },
  );
  test("ownership acquired during pending stop admits the subscriber as viewer", async () => {
    let release = () => {};
    const stopGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness();
    const old = await h.subscribe();
    h.sources[0].stopGate = stopGate;
    old.destroy();
    Reflect.get(h.server, "onConnectionClose").call(h.server, old);
    h.timer.advanceTime(3000);
    await flush();
    const socket = new FakeSocket();
    const joining = h.server.line(socket, {
      action: "subscribe",
      sessionUuid: "a",
      deviceId: device.deviceId,
    });
    try {
      await flush();
      expect(Reflect.get(h.server, "socketDeviceIds").has(socket)).toBe(false);
      expect(h.server.activeDeviceIds()).toEqual([]);
      h.state.owner = "b";
      h.ownership.changed();
      release();
      await joining;
      expect(messages(socket)).toHaveLength(1);
      expect(messages(socket)[0]).toMatchObject({ success: true, subscriptionKind: "viewer" });
      expect(binary(socket)).toHaveLength(1);
      expect(socket.destroyed).toBe(false);
      expect(h.sources).toHaveLength(2);
      expect(h.server.subscriberCount(device.deviceId)).toBe(1);
    } finally {
      release();
      await joining;
    }
  });
  test.each([
    "daemon_shutdown",
    "session_ended",
    "device_removed",
    "device_restored",
    "identity_quarantined",
    "authorization_failure",
  ] as const)(
    "logs %s once at the expected severity with device, kind and reason",
    async (event) => {
      let reject = false;
      const h = await harness(
        event === "authorization_failure"
          ? {
              authenticator: {
                authorize: () => {
                  if (reject) {
                    throw new Error("secret session UUID");
                  }
                },
              },
            }
          : {},
      );
      const socket = await h.subscribe();
      const kind = event === "authorization_failure" ? "owner" : "viewer";
      const reason = event === "authorization_failure" ? "session_ended" : event;
      const info = spyOn(logger, "info").mockImplementation(() => {});
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        if (event === "daemon_shutdown") {
          await h.server.close();
        } else if (event === "device_restored") {
          h.lifecycle.deviceRestored(device.deviceId);
          h.lifecycle.deviceRestored(device.deviceId);
        } else if (event === "device_removed") {
          h.lifecycle.deviceRemoved(device.deviceId);
        } else if (event === "identity_quarantined") {
          h.state.quarantined = true;
          h.lifecycle.deviceIdentityChanged(device.deviceId);
        } else if (event === "authorization_failure") {
          reject = true;
          h.ownership.changed();
        } else {
          h.state.live.delete("a");
          h.released("a");
        }
        h.ownership.changed();
        h.lifecycle.deviceRemoved(device.deviceId);
        terminal(socket, reason);
        const message = `[VideoStream] ending subscriber: deviceId=${device.deviceId} kind=${kind} reason=${reason}`;
        const expected =
          event === "daemon_shutdown" || event === "session_ended" || event === "device_restored"
            ? info
            : warn;
        const other = expected === info ? warn : info;
        expect(expected.mock.calls.filter(([text]) => text === message)).toHaveLength(1);
        expect(other.mock.calls.filter(([text]) => text === message)).toHaveLength(0);
        expect(JSON.stringify([...info.mock.calls, ...warn.mock.calls])).not.toContain(
          "secret session UUID",
        );
      } finally {
        info.mockRestore();
        warn.mockRestore();
      }
    },
  );
  test("logs downgrade once at info and the later viewer end once", async () => {
    const h = await harness({ owner: "a" });
    const socket = await h.subscribe();
    const info = spyOn(logger, "info").mockImplementation(() => {});
    try {
      h.state.owner = "b";
      h.ownership.changed();
      h.ownership.changed();
      h.state.live.delete("a");
      h.released("a");
      h.released("a");
      terminal(socket, "session_ended");
      expect(
        info.mock.calls.filter(
          ([text]) =>
            text ===
            `[VideoStream] downgraded subscriber: deviceId=${device.deviceId} kind=viewer reason=downgrade`,
        ),
      ).toHaveLength(1);
      expect(
        info.mock.calls.filter(
          ([text]) =>
            text ===
            `[VideoStream] ending subscriber: deviceId=${device.deviceId} kind=viewer reason=session_ended`,
        ),
      ).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });
  test.each(["owner", "viewer"] as const)(
    "pipelined duplicate %s subscribe resolves once and shutdown destroys the disconnected socket",
    async (kind) => {
      let resolveDevice = () => {};
      const resolveGate = new Promise<void>((resolve) => {
        resolveDevice = resolve;
      });
      const h = await harness({ owner: kind === "owner" ? "a" : null, resolveGate });
      const socket = new PendingEndSocket();
      h.server.accept(socket);
      const request = { action: "subscribe", sessionUuid: "a", deviceId: device.deviceId };
      const joining = h.server.line(socket, request);
      await h.server.line(socket, request);
      expect(h.resolveCalls()).toBe(1);
      expect(messages(socket)).toHaveLength(0);
      expect(h.sources).toHaveLength(0);

      resolveDevice();
      await joining;
      expect(messages(socket)).toHaveLength(1);
      expect(messages(socket)[0]).toMatchObject({ success: true, subscriptionKind: kind });
      expect(h.resolveCalls()).toBe(1);
      expect(h.sources).toHaveLength(1);
      expect(h.server.subscriberCount(device.deviceId)).toBe(1);

      const closing = h.server.close();
      expect(messages(socket).at(-1)).toMatchObject({ reason: "daemon_shutdown", terminal: true });
      expect(binary(socket).at(-1)).toEqual(encodeSubscriptionNotice("daemon_shutdown"));
      expect(socket.endCalls).toBeGreaterThan(0);
      expect(h.server.subscriberCount(device.deviceId)).toBe(0);
      // Peer destruction arrives after endSubscriber has removed all subscription bookkeeping.
      // No finish/close is emitted by this fake until the relay explicitly destroys it.
      socket.emit("end");
      await closing;
      expect(socket.destroyed).toBe(true);
    },
  );
  test("shutdown destroys an already detached socket after its terminal writes finish", async () => {
    let resolveDevice = () => {};
    const resolveGate = new Promise<void>((resolve) => {
      resolveDevice = resolve;
    });
    const h = await harness({ resolveGate });
    const detached = new PendingEndSocket();
    h.server.accept(detached);
    const request = { action: "subscribe", sessionUuid: "a", deviceId: device.deviceId };
    const joining = h.server.line(detached, request);
    await h.server.line(detached, request);
    resolveDevice();
    await joining;
    h.lifecycle.deviceRemoved(device.deviceId);
    expect(messages(detached).at(-1)?.reason).toBe("device_removed");
    expect(h.server.subscriberCount(device.deviceId)).toBe(0);

    const idle = new FakeSocket();
    h.server.accept(idle);
    const closing = h.server.close();
    await flush();
    // Model successful flushing for the detached connection, without any peer FIN.
    detached.emit("finish");
    await closing;
    expect(detached.destroyed).toBe(true);
    expect(idle.destroyed).toBe(true);
  });
  test("shutdown ends idle and resolving sockets and refuses late capture attachment", async () => {
    let resolveDevice = () => {};
    const resolveGate = new Promise<void>((resolve) => {
      resolveDevice = resolve;
    });
    const h = await harness({ resolveGate });
    const resolving = new FakeSocket();
    const idle = new FakeSocket();
    h.server.accept(resolving);
    h.server.accept(idle);
    const request = { action: "subscribe", sessionUuid: "a", deviceId: device.deviceId };
    const joining = h.server.line(resolving, request);
    await h.server.line(resolving, request);
    expect(h.resolveCalls()).toBe(1);
    const ends = [spyOn(resolving, "end"), spyOn(idle, "end")];
    try {
      await h.server.close();
      for (const end of ends) {
        expect(end).toHaveBeenCalled();
      }
      expect(resolving.destroyed).toBe(true);
      expect(idle.destroyed).toBe(true);
      expect(messages(resolving)).toHaveLength(0);
    } finally {
      resolveDevice();
      await joining;
      for (const end of ends) {
        end.mockRestore();
      }
    }
    expect(h.sources).toHaveLength(0);
    expect(h.server.subscriberCount(device.deviceId)).toBe(0);
  });
  test("unowned viewers survive acquisition and release without notices and keep capture alive", async () => {
    const h = await harness();
    const a = await h.subscribe();
    const b = await h.subscribe("b");
    expect(messages(a)[0].subscriptionKind).toBe("viewer");
    const before = a.written.length;
    h.state.owner = "b";
    h.ownership.changed();
    h.state.owner = null;
    h.ownership.changed();
    expect(a.written).toHaveLength(before);
    expect(b.destroyed).toBe(false);
    expect(h.server.subscriberCount(device.deviceId)).toBe(2);
    h.timer.advanceTime(3000);
    await flush();
    expect(h.sources[0].stopped).toBe(false);
    expect(h.sources[0].consumerStates.at(-1)).toBe(true);
    h.emit();
    expect(a.written.length).toBeGreaterThan(before);
  });
  test("live rebound owner downgrades once and extra input cannot change hints", async () => {
    const h = await harness({ owner: "a" });
    const a = await h.subscribe("a", { quality: "low" });
    expect(messages(a)[0].subscriptionKind).toBe("owner");
    h.state.owner = "b";
    h.ownership.changed();
    h.state.owner = null;
    h.ownership.changed();
    expect(binary(a)).toEqual([binary(a)[0], encodeSubscriptionNotice("downgraded_to_viewer")]);
    expect(messages(a)).toHaveLength(1);
    expect(a.destroyed).toBe(false);
    expect(Reflect.get(h.server, "socketSubscriptionKinds").get(a)).toBe("viewer");
    const beforeMedia = binary(a).length;
    h.emit();
    expect(binary(a).length).toBeGreaterThan(beforeMedia);
    expect(messages(a)).toHaveLength(1);
    expect(() =>
      assertMayControl("viewer", {
        transport: "video_relay",
        action: "subscribe",
        postHandshake: true,
      }),
    ).toThrow(ViewerReadOnlyError);
    await h.server.line(a, { action: "subscribe", quality: "high", fps: 15, bitrateKbps: 6000 });
    await h.server.line(a, { action: "stop" });
    h.timer.advanceTime(200);
    await flush();
    expect(h.sources).toHaveLength(1);
    expect(h.hints[0].quality).toBe("low");
    h.state.live.delete("a");
    h.ownership.changed();
    terminal(a, "session_ended");
    expect(messages(a).at(-1)?.subscriptionKind).toBe("viewer");
  });
  test("owner release ends identity and capture stops only after idle grace", async () => {
    const h = await harness({ owner: "a" });
    const a = await h.subscribe();
    h.state.owner = null;
    h.state.live.delete("a");
    h.ownership.changed();
    terminal(a, "session_ended");
    expect(binary(a).at(-1)).toEqual(encodeSubscriptionNotice("session_ended"));
    expect(h.server.subscriberCount(device.deviceId)).toBe(0);
    expect(h.sources[0].stopped).toBe(false);
    h.timer.advanceTime(3000);
    await flush();
    expect(h.sources[0].stopped).toBe(true);
  });
  test("device-less viewer session expiry ends independently of device ownership", async () => {
    const h = await harness();
    const a = await h.subscribe();
    const b = await h.subscribe("b");
    h.state.live.delete("a");
    h.released("a");
    terminal(a, "session_ended");
    expect(b.destroyed).toBe(false);
    expect(h.server.subscriberCount(device.deviceId)).toBe(1);
  });
  test("being released identity also ends an unowned viewer", async () => {
    const h = await harness();
    const a = await h.subscribe();
    h.state.releasing = true;
    h.ownership.changed();
    terminal(a, "session_ended");
  });
  test.each(["device_removed", "device_restored"] as const)(
    "%s ends owner and viewer with binary END then typed terminal",
    async (reason) => {
      const h = await harness();
      const viewer = await h.subscribe();
      h.state.owner = "b";
      h.ownership.changed();
      const owner = await h.subscribe("b");
      if (reason === "device_restored") {
        h.lifecycle.deviceRestored(device.deviceId);
        h.lifecycle.deviceRestored(device.deviceId);
      } else {
        h.lifecycle.deviceRemoved(device.deviceId);
      }
      for (const socket of [viewer, owner]) {
        terminal(socket, reason);
        expect(binary(socket).at(-1)).toEqual(encodeSubscriptionNotice(reason));
        expect(binary(socket).at(-1)?.readBigUInt64BE(0)).toBe(
          (1n << 61n) | BigInt(reason === "device_restored" ? 6 : 2),
        );
        expect(messages(socket).at(-1)?.subscriptionKind).toBe(
          socket === viewer ? "viewer" : "owner",
        );
        expect(typeof socket.written.at(-1)).toBe("string");
      }
      expect(h.server.subscriberCount(device.deviceId)).toBe(0);
      h.state.owner = null;
      const again = await h.subscribe();
      expect(messages(again)[0]).toMatchObject({ success: true, subscriptionKind: "viewer" });
      expect(h.server.subscriberCount(device.deviceId)).toBe(1);
    },
  );
  test("pending owner downgrade is reflected only in its ack, and a pending viewer survives acquisition", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness({ owner: "a", startGate: gate });
    const owner = new FakeSocket();
    const joiningOwner = h.server.line(owner, {
      action: "subscribe",
      sessionUuid: "a",
      deviceId: device.deviceId,
    });
    await flush();
    h.state.owner = null;
    h.ownership.changed();
    expect(owner.written).toHaveLength(0);
    const viewer = new FakeSocket();
    const joiningViewer = h.server.line(viewer, {
      action: "subscribe",
      sessionUuid: "b",
      deviceId: device.deviceId,
    });
    await flush();
    h.state.owner = "a";
    h.ownership.changed();
    expect(viewer.written).toHaveLength(0);
    release();
    await Promise.all([joiningOwner, joiningViewer]);
    for (const socket of [owner, viewer]) {
      expect(messages(socket)[0]).toMatchObject({ success: true, subscriptionKind: "viewer" });
      expect(binary(socket)).toHaveLength(1);
    }
  });
  test("viewer subscribe-time hints still start and reconfigure the shared capture", async () => {
    const h = await harness();
    const a = await h.subscribe("a", { quality: "low", fps: 20, bitrateKbps: 2000 });
    expect(h.hints[0]).toMatchObject({ quality: "low", fps: 20, bitrateBps: 2_000_000 });
    const b = await h.subscribe("b", { quality: "high", fps: 15, bitrateKbps: 6000 });
    for (const socket of [a, b]) {
      expect(messages(socket)[0].subscriptionKind).toBe("viewer");
    }
    h.timer.advanceTime(200);
    await flush();
    expect(h.hints[1]).toMatchObject({ quality: "high", fps: 15, bitrateBps: 6_000_000 });
    expect(h.server.subscriberCount(device.deviceId)).toBe(2);
  });
  test("destroyed subscriber is detached without lifecycle writes or reuse", async () => {
    const h = await harness();
    const a = await h.subscribe();
    const before = a.written.length;
    a.destroy();
    h.lifecycle.deviceRemoved(device.deviceId);
    expect(a.written).toHaveLength(before);
    expect(h.server.subscriberCount(device.deviceId)).toBe(0);
    await h.server.line(a, { action: "subscribe", sessionUuid: "a", deviceId: device.deviceId });
    expect(h.server.subscriberCount(device.deviceId)).toBe(0);
    for (const name of [
      "socketDeviceIds",
      "socketSessionUuids",
      "socketSubscriptionKinds",
      "acknowledgedSubscribers",
      "subscribing",
      "outboundStalls",
    ] as const) {
      expect(Reflect.get(h.server, name).has(a)).toBe(false);
    }
  });
  test.each(["device_removed", "device_restored"] as const)(
    "pending %s sends JSON only and never a later success ack",
    async (reason) => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = await harness({ startGate: gate });
      const socket = new FakeSocket();
      const joining = h.server.line(socket, {
        action: "subscribe",
        sessionUuid: "a",
        deviceId: device.deviceId,
      });
      await flush();
      expect(h.server.subscriberCount(device.deviceId)).toBe(1);
      if (reason === "device_restored") {
        h.lifecycle.deviceRestored(device.deviceId);
      } else {
        h.lifecycle.deviceRemoved(device.deviceId);
      }
      terminal(socket, reason);
      expect(binary(socket)).toHaveLength(0);
      release();
      await joining;
      expect(messages(socket)).toHaveLength(1);
    },
  );
  test.each(["identity_quarantined", "daemon_shutdown"] as const)(
    "pending %s ends without binary data when startup later settles",
    async (reason) => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = await harness({ startGate: gate });
      const socket = new FakeSocket();
      const joining = h.server.line(socket, {
        action: "subscribe",
        sessionUuid: "a",
        deviceId: device.deviceId,
      });
      await flush();
      let closing: Promise<void> | undefined;
      if (reason === "daemon_shutdown") {
        closing = h.server.close();
      } else {
        h.state.quarantined = true;
        h.lifecycle.deviceIdentityChanged(device.deviceId);
      }
      terminal(socket, reason);
      expect(binary(socket)).toHaveLength(0);
      release();
      await joining;
      await closing;
      expect(messages(socket)).toHaveLength(1);
      expect(h.server.subscriberCount(device.deviceId)).toBe(0);
    },
  );
  test("quarantine ends subscribers, lift and unrelated invalidations do nothing", async () => {
    const h = await harness();
    const a = await h.subscribe();
    const before = a.written.length;
    h.lifecycle.deviceIdentityChanged(device.deviceId);
    h.lifecycle.deviceIdentityChanged("elsewhere");
    expect(a.written).toHaveLength(before);
    h.state.quarantined = true;
    h.lifecycle.deviceIdentityChanged(device.deviceId);
    terminal(a, "identity_quarantined");
    expect(binary(a).at(-1)).toEqual(encodeSubscriptionNotice("identity_quarantined"));
    h.state.quarantined = false;
    h.lifecycle.deviceIdentityChanged(device.deviceId);
    const again = await h.subscribe();
    h.lifecycle.deviceIdentityChanged(device.deviceId);
    expect(again.destroyed).toBe(false);
  });
  test("shutdown ends everyone before capture stop and removes all listeners", async () => {
    const h = await harness();
    const viewer = await h.subscribe();
    h.state.owner = "b";
    const owner = await h.subscribe("b");
    expect(h.ownership.listeners.size).toBe(1);
    expect(h.lifecycleListenerCount()).toBe(3);
    h.sources[0].onStop = () => {
      for (const socket of [viewer, owner]) {
        terminal(socket, "daemon_shutdown");
      }
      expect(h.ownership.listeners.size).toBe(0);
      expect(h.lifecycleListenerCount()).toBe(0);
      expect(h.releaseListeners.size).toBe(0);
    };
    await h.server.close();
    for (const socket of [viewer, owner]) {
      expect(binary(socket).at(-1)).toEqual(encodeSubscriptionNotice("daemon_shutdown"));
    }
    expect(h.sources[0].stopped).toBe(true);
    expect(h.server.activeDeviceIds()).toEqual([]);
    h.ownership.changed();
    h.lifecycle.deviceRemoved(device.deviceId);
  });
  test("auth off never revokes or downgrades on ownership changes", async () => {
    const h = await harness({ authOff: true });
    const a = await h.subscribe("unknown");
    const before = a.written.length;
    expect(messages(a)[0]).toMatchObject({ success: true, subscriptionKind: "owner" });
    h.state.owner = "other";
    h.state.live.clear();
    h.ownership.changed();
    h.state.owner = null;
    h.ownership.changed();
    expect(a.written).toHaveLength(before);
    expect(a.destroyed).toBe(false);
    expect(h.server.subscriberCount(device.deviceId)).toBe(1);
  });
  test("auth-off exemption is ownership-only; lifecycle endings remain typed", async () => {
    const h = await harness({ authOff: true });
    const a = await h.subscribe("unknown");
    h.lifecycle.deviceRemoved(device.deviceId);
    terminal(a, "device_removed");
    expect(binary(a).at(-1)).toEqual(encodeSubscriptionNotice("device_removed"));
  });
  test("admission attaches a live non-owner as viewer to an owner's capture", async () => {
    const h = await harness({ owner: "b" });
    const owner = await h.subscribe("b");
    const viewer = await h.subscribe("a", { deviceId: undefined });
    expect(messages(owner)[0]).toMatchObject({ success: true, subscriptionKind: "owner" });
    expect(messages(viewer)[0]).toMatchObject({ success: true, subscriptionKind: "viewer" });
    expect(h.sources).toHaveLength(1);
    h.state.owner = "a";
    h.ownership.changed();
    expect(binary(owner).at(-1)).toEqual(encodeSubscriptionNotice("downgraded_to_viewer"));
    expect(viewer.destroyed).toBe(false);
    h.state.owner = null;
    h.ownership.changed();
    expect(h.server.subscriberCount(device.deviceId)).toBe(2);
  });
  test("legacy authenticator failure ends just its rejected subscriber", async () => {
    let reject = false;
    const h = await harness({
      authenticator: {
        authorize: ({ sessionUuid }) => {
          if (reject && sessionUuid === "a") {
            throw new Error("Session lost access");
          }
        },
      },
    });
    const a = await h.subscribe();
    const b = await h.subscribe("b");
    reject = true;
    h.ownership.changed();
    terminal(a, "session_ended");
    expect(b.destroyed).toBe(false);
    expect(h.server.subscriberCount(device.deviceId)).toBe(1);
  });
});

test("restore without a capture is a no-op and does not affect another device", async () => {
  const h = await harness();
  h.lifecycle.deviceRestored(device.deviceId);
  expect(h.server.activeDeviceIds()).toEqual([]);
  expect(h.sources).toHaveLength(0);
  const socket = await h.subscribe();
  const writes = socket.written.length;
  h.lifecycle.deviceRestored("unrelated");
  expect(socket.written).toHaveLength(writes);
  expect(h.server.subscriberCount(device.deviceId)).toBe(1);
});

test.each(["missing", "unknown", "expired", "releasing", "observer"] as const)(
  "viewer admission rejects %s before discovery or capture",
  async (identity) => {
    const h = await harness({ owner: "b" });
    if (identity === "expired") {
      h.state.live.delete("a");
    }
    if (identity === "releasing") {
      h.state.releasing = true;
    }
    const sessionUuid =
      identity === "missing"
        ? undefined
        : identity === "unknown" || identity === "observer"
          ? identity
          : "a";
    const socket = await h.subscribe("a", { sessionUuid });
    expect(messages(socket)[0]).toMatchObject({ success: false });
    expect(messages(socket)[0].error).toContain(
      identity === "missing"
        ? "authenticated daemon session"
        : identity === "releasing"
          ? "being released"
          : "unknown or expired",
    );
    expect(h.resolveCalls()).toBe(0);
    expect(h.sources).toHaveLength(0);
  },
);
test("admitted viewer survives owner release, ends on removal and re-subscribes", async () => {
  const h = await harness({ owner: "b" });
  const owner = await h.subscribe("b");
  const viewer = await h.subscribe("a");
  expect(messages(viewer)[0]).toMatchObject({ success: true, subscriptionKind: "viewer" });
  h.state.live.delete("b");
  h.state.owner = null;
  h.released("b");
  h.ownership.changed();
  terminal(owner, "session_ended");
  expect(viewer.destroyed).toBe(false);
  expect(h.sources[0].stopped).toBe(false);
  h.lifecycle.deviceRemoved(device.deviceId);
  terminal(viewer, "device_removed");
  h.state.owner = "other";
  const again = await h.subscribe("a");
  expect(messages(again)[0]).toMatchObject({ success: true, subscriptionKind: "viewer" });
});
test.each([
  { owner: "a", joiner: "b", authOff: false, kind: "viewer", reconfigure: false },
  { owner: null, joiner: "b", authOff: false, kind: "viewer", reconfigure: true },
  { owner: "a", joiner: "a", authOff: false, kind: "owner", reconfigure: true },
  { owner: "a", joiner: "b", authOff: true, kind: "owner", reconfigure: true },
])("relay hint authority preserves owner and owner-less semantics: %j", async (scenario) => {
  const h = await harness(scenario);
  await h.subscribe("a", {
    quality: "low",
    fps: 5,
    bitrateKbps: 1000,
    size: { width: 320, height: 640 },
  });
  const joiner = await h.subscribe(scenario.joiner, {
    quality: "high",
    fps: 15,
    bitrateKbps: 6000,
    size: { width: 800, height: 1600 },
  });
  expect(messages(joiner)[0]).toMatchObject({ success: true, subscriptionKind: scenario.kind });
  h.timer.advanceTime(200);
  await flush();
  expect(h.sources).toHaveLength(scenario.reconfigure ? 2 : 1);
  expect(h.hints.at(-1)).toMatchObject({
    quality: scenario.reconfigure ? "high" : "low",
    fps: scenario.reconfigure ? 15 : 5,
    bitrateBps: scenario.reconfigure ? 6000000 : 1000000,
    size: { width: 320, height: 640 },
  });
});

test("transport default rejects a registered observer-only session", async () => {
  const sessions = releasingSessionHarness();
  sessions.observers.register("observer", "desktop");
  expect(sessions.observers.resolveObserverScope("observer").kind).not.toBe("denied");
  const state = DaemonState.getInstance();
  const stateSpies = [
    spyOn(state, "isInitialized").mockReturnValue(true),
    spyOn(state, "getSessionManager").mockReturnValue(sessions.manager),
    spyOn(state, "getObserverSessionRegistry").mockReturnValue(sessions.observers),
  ];
  const previousAuth = process.env.AUTOMOBILE_DAEMON_STREAM_AUTH;
  process.env.AUTOMOBILE_DAEMON_STREAM_AUTH = "1";
  try {
    const h = await harness({ useDefaultAuthenticator: true });
    const socket = await h.subscribe("observer");
    expect(messages(socket)[0]).toMatchObject({
      success: false,
      error: expect.stringContaining("unknown or expired"),
    });
    expect(h.resolveCalls()).toBe(0);
    expect(h.sources).toHaveLength(0);
  } finally {
    for (const spy of stateSpies) {
      spy.mockRestore();
    }
    if (previousAuth === undefined) {
      delete process.env.AUTOMOBILE_DAEMON_STREAM_AUTH;
    } else {
      process.env.AUTOMOBILE_DAEMON_STREAM_AUTH = previousAuth;
    }
    sessions.dispose();
  }
});

test.each([false, true])(
  "viewer-first relay yields hints and size to owner (hints=%s)",
  async (withHints) => {
    const h = await harness({ owner: "b" });
    const viewer = await h.subscribe("a", {
      quality: "low",
      fps: 5,
      bitrateKbps: 1000,
      size: { width: 320, height: 640 },
    });
    const ownerHints = withHints
      ? { quality: "high", fps: 15, bitrateKbps: 6000, size: { width: 800, height: 1600 } }
      : {};
    const owner = await h.subscribe("b", ownerHints);
    expect(messages(owner)[0]).toMatchObject({ success: true, subscriptionKind: "owner" });
    h.timer.advanceTime(200);
    await flush();
    expect(h.hints.at(-1)).toMatchObject({
      quality: withHints ? "high" : undefined,
      fps: withHints ? 15 : 30,
      bitrateBps: withHints ? 6000000 : undefined,
      size: withHints ? { width: 800, height: 1600 } : undefined,
    });
    expect(h.hints[0]).toMatchObject({
      quality: undefined,
      fps: 30,
      bitrateBps: undefined,
      size: undefined,
    });
    expect(viewer.destroyed).toBe(false);
  },
);

test("subscribe forwards the platform to video discovery", async () => {
  const platforms: Array<string | undefined> = [];
  const { server } = await harness({ onResolve: (platform) => platforms.push(platform) });
  const socket = new FakeSocket();
  server.accept(socket);
  await server.line(socket, { action: "subscribe", sessionUuid: "a", platform: "ios" });
  expect(platforms).toEqual(["ios"]);
});
