import { createDeviceCaptureRegistry } from "../../src/features/webrtc/deviceCaptureRegistry";
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import * as manager from "../../src/server/webrtcStreamManager";
import { WebRtcStreamSocketServer } from "../../src/daemon/webrtcStreamSocketServer";
import type { WebRtcStreamSocketRequest } from "../../src/daemon/webrtcStreamSocketTypes";
import {
  SessionScopedStreamAuthenticator,
  type StreamSocketAuthenticator,
} from "../../src/daemon/streamSocketAuth";
import { DaemonState } from "../../src/daemon/daemonState";
import { releasingSessionHarness } from "../helpers/releasingSessionHarness";
import { StreamDeviceLifecycleEmitter } from "../../src/daemon/streamDeviceLifecycleEvents";
import { createWebRtcStreamDeviceIncarnationListener } from "../../src/server/webrtcStreamIncarnationListener";
import { WebRtcPublisher, WhipClient, type H264CaptureSource } from "../../src/features/webrtc";
import type { RTCPeerConnection } from "werift";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { logger } from "../../src/utils/logger";
import type { BootedDevice } from "../../src/models";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  createSuccessfulWhipFetch,
  FakeConnectedPeerConnection,
  FakeH264Source,
} from "../helpers/webrtcFakes";

const endpoint = "http://127.0.0.1:8000/whip";
let previousEndpoint: string | undefined;
beforeAll(() => {
  previousEndpoint = process.env.AUTOMOBILE_WEBRTC_WHIP_ENDPOINT;
  process.env.AUTOMOBILE_WEBRTC_WHIP_ENDPOINT = endpoint;
});
afterAll(() => {
  if (previousEndpoint === undefined) {
    delete process.env.AUTOMOBILE_WEBRTC_WHIP_ENDPOINT;
  } else {
    process.env.AUTOMOBILE_WEBRTC_WHIP_ENDPOINT = previousEndpoint;
  }
});
const device = { deviceId: "viewer-device", platform: "android", name: "Fake" } as BootedDevice;
class TestServer extends WebRtcStreamSocketServer {
  started(): void {
    this.onServerStarted();
  }
  request(request: WebRtcStreamSocketRequest) {
    return this.handleRequest(request);
  }
  line(socket: FakeSocket, request: WebRtcStreamSocketRequest): Promise<void> {
    return this.processLine(socket, JSON.stringify(request));
  }
  error(error: unknown) {
    return this.createErrorResponse(undefined, String(error));
  }
}
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await Promise.resolve();
  }
}
const servers: TestServer[] = [];
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  manager.resetWebRtcStreamManager();
  for (const spy of spies.splice(0)) {
    spy.mockRestore();
  }
});
function harness(
  options: {
    owner?: string;
    authOff?: boolean;
    authenticator?: StreamSocketAuthenticator;
    useDefaultAuthenticator?: boolean;
    startGate?: Promise<void>;
  } = {},
) {
  const timer = new FakeTimer();
  const lifecycle = new StreamDeviceLifecycleEmitter();
  const ownership = new Set<(id: string) => void>();
  const releases = new Set<(id: string) => void>();
  const observerReleases = new Set<(id: string) => void>();
  let lifecycleListeners = 0;
  const state = {
    owner: options.owner ?? (null as string | null),
    live: new Set(["a", "b"]),
    releasing: false,
    quarantined: false,
  };
  const sources: FakeH264Source[] = [];
  const captureHints: Array<{ bitrateBps?: number; fps?: number }> = [];
  const publishers: WebRtcPublisher[] = [];
  manager.setWebRtcStreamManagerDependencies({
    captureRegistry: createDeviceCaptureRegistry(),
    idGenerator: new CountingIdGenerator(),
    timer,
    now: () => new Date(timer.now()),
    isSessionLive: (id) => state.live.has(id),
    resolveVideoJar: async () => null,
    createSource: (options) => {
      captureHints.push(options);
      const source = new FakeH264Source();
      sources.push(source);
      return source as H264CaptureSource;
    },
    createPublisher: (config, deps) => {
      const publisher = new WebRtcPublisher(config, {
        ...deps,
        timer,
        createPeerConnection: () =>
          new FakeConnectedPeerConnection() as unknown as RTCPeerConnection,
        createWhipClient: (opts) =>
          new WhipClient({
            ...opts,
            fetchImpl: createSuccessfulWhipFetch([], "/resource", "4d002a"),
          }),
      });
      publishers.push(publisher);
      return publisher;
    },
  });
  const info = spyOn(logger, "info").mockImplementation(() => {});
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const debug = spyOn(logger, "debug").mockImplementation(() => {});
  spies.push(info, warn, debug);
  const session = {};
  const server = new TestServer(
    "/unused/webrtc-viewer.sock",
    timer,
    {
      resolveDevice: async () => device,
      startStream: async (request) => {
        const stream = await manager.startWebRtcStream({
          ...request,
          overrides: request.overrides,
        });
        await options.startGate;
        return stream;
      },
      stopStream: manager.stopWebRtcStream,
      stopStreamAsOwner: manager.stopWebRtcStreamAsOwner,
      releaseOwnLeases: manager.releaseWebRtcStreamOwnLeases,
      getControlContext: manager.getWebRtcStreamControlContext,
      getStream: manager.getWebRtcStreamDescriptor,
      listStreams: manager.listWebRtcStreams,
      awaitReadiness: manager.waitForWebRtcStreamReadiness,
      reconcileOwnership: manager.reconcileWebRtcStreamsForDeviceOwnership,
      stopAllStreams: manager.stopAllWebRtcStreams,
      getSubscriptionKind: manager.getWebRtcSubscriptionKind,
      liveDeviceIds: manager.getWebRtcStreamDeviceIds,
      endStreamsForDevice: manager.endWebRtcStreamsForDevice,
      ownershipChanges: () => ({
        onDeviceOwnershipChange: (cb) => {
          ownership.add(cb);
          return () => {
            ownership.delete(cb);
          };
        },
      }),
      sessionReleases: {
        subscribe: (cb) => {
          releases.add(cb);
          return () => {
            releases.delete(cb);
          };
        },
      },
      observerReleases: {
        subscribe: (cb) => {
          observerReleases.add(cb);
          return () => {
            observerReleases.delete(cb);
          };
        },
      },
      deviceLifecycle: () => ({
        onDeviceRestored: (cb) => lifecycle.onDeviceRestored(cb),
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
            "webrtcStream",
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
  server.started();
  async function request(input: WebRtcStreamSocketRequest) {
    try {
      return await server.request({ sessionUuid: "a", ...input });
    } catch (error) {
      return server.error(error);
    }
  }
  async function start(sessionUuid: string | undefined = "a", leaseId?: string) {
    return request({ action: "start", sessionUuid, leaseId });
  }
  async function changed() {
    for (const cb of ownership) {
      cb(device.deviceId);
    }
    await flush();
  }
  return {
    timer,
    lifecycle,
    ownership,
    releases,
    observerReleases,
    state,
    sources,
    captureHints,
    publishers,
    debug,
    info,
    warn,
    server,
    request,
    start,
    changed,
    lifecycleCount: () => lifecycleListeners,
  };
}
function endings(h: ReturnType<typeof harness>) {
  return [...h.info.mock.calls, ...h.warn.mock.calls].filter(([message]) =>
    String(message).includes("ending subscription:"),
  );
}

test("a: viewer survives acquisition and release with its original lease", async () => {
  const h = harness();
  const first = await h.start();
  expect(first.subscriptionKind).toBe("viewer");
  h.state.owner = "b";
  await h.changed();
  h.state.owner = null;
  await h.changed();
  const status = await h.request({
    action: "status",
    streamId: first.stream?.streamId,
    leaseId: first.stream?.lease?.id,
  });
  expect(status).toMatchObject({ success: true, subscriptionKind: "viewer" });
  expect(h.sources[0].stopped).toBe(false);
  expect(endings(h)).toHaveLength(0);
});
test("b: losing ownership downgrades once; its lease can renew and release", async () => {
  const h = harness({ owner: "a" });
  const first = await h.start();
  h.state.owner = null;
  await h.changed();
  await h.changed();
  const address = { streamId: first.stream?.streamId, leaseId: first.stream?.lease?.id };
  h.timer.advanceTime(1000);
  const renewed = await h.request({ action: "start", ...address });
  expect(renewed).toMatchObject({ success: true, subscriptionKind: "viewer" });
  expect(renewed.stream?.lease?.id).toBe(first.stream?.lease?.id);
  expect(renewed.stream?.lease?.expiresAt).not.toBe(first.stream?.lease?.expiresAt);
  for (const action of ["status", "await", "list"] as const) {
    expect(await h.request({ action, ...address, readiness: "capture_ready" })).toMatchObject({
      success: true,
      subscriptionKind: "viewer",
    });
  }
  expect(
    h.info.mock.calls.filter(([message]) => String(message).includes("downgraded subscription:")),
  ).toHaveLength(1);
  expect(await h.request({ action: "stop", ...address })).toMatchObject({ success: true });
  expect(h.sources[0].stopped).toBe(true);
});
test.each(["released", "expired", "releasing", "owner release"])(
  "c: %s ends the subscribing identity",
  async (cause) => {
    const h = harness(cause === "owner release" ? { owner: "a" } : {});
    const first = await h.start();
    if (cause === "releasing") {
      h.state.releasing = true;
      await h.changed();
    } else {
      h.state.live.delete("a");
      h.state.owner = null;
      for (const cb of h.releases) {
        cb("a");
      }
      await flush();
    }
    expect(h.sources[0].stopped).toBe(true);
    h.state.releasing = false;
    // A still-live identity can inspect the typed tombstone, without renewing the ended lease.
    expect(
      await h.request({
        action: "status",
        sessionUuid: "b",
        streamId: first.stream?.streamId,
        leaseId: first.stream?.lease?.id,
      }),
    ).toMatchObject({ success: false, reason: "session_ended" });
    expect(endings(h)).toHaveLength(1);
  },
);
test("c: a released or expired observer's viewer stream ends without waiting for its lease (#11076)", async () => {
  const h = harness({ owner: "b" });
  const first = await h.start();
  expect(first.subscriptionKind).toBe("viewer");
  // The observer registry no longer admits "a"; no device owner changed and no session released.
  h.state.live.delete("a");
  for (const cb of h.observerReleases) {
    cb("a");
  }
  await flush();
  expect(h.sources[0].stopped).toBe(true);
  expect(endings(h)).toHaveLength(1);
});
test("d: removal ends owner and viewer; all lease reads are typed and start can re-subscribe", async () => {
  const h = harness();
  const viewer = await h.start();
  h.state.owner = "b";
  await h.changed();
  const owner = await h.start("b");
  h.lifecycle.deviceRemoved(device.deviceId);
  await flush();
  for (const [first, kind, sessionUuid] of [
    [viewer, "viewer", "a"],
    [owner, "owner", "b"],
  ] as const) {
    for (const action of ["status", "await", "stop"] as const) {
      expect(
        await h.request({
          action,
          sessionUuid,
          streamId: first.stream?.streamId,
          leaseId: first.stream?.lease?.id,
        }),
      ).toMatchObject({ success: false, reason: "device_removed", subscriptionKind: kind });
    }
  }
  expect(
    h.warn.mock.calls.filter(([message]) => String(message).includes("ending subscription:")),
  ).toHaveLength(2);
  h.state.owner = null;
  const again = await h.start("a", viewer.stream?.lease?.id);
  expect(again).toMatchObject({ success: true, subscriptionKind: "viewer" });
  expect(again.stream?.lease?.id).not.toBe(viewer.stream?.lease?.id);
});
test("e: quarantine ends; lift and benign invalidation preserve subscriptions", async () => {
  const h = harness();
  const first = await h.start();
  h.lifecycle.deviceIdentityChanged(device.deviceId);
  h.lifecycle.deviceIdentityChanged("unrelated");
  await flush();
  expect(endings(h)).toHaveLength(0);
  h.state.quarantined = true;
  h.lifecycle.deviceIdentityChanged(device.deviceId);
  await flush();
  expect(
    await h.request({
      action: "status",
      streamId: first.stream?.streamId,
      leaseId: first.stream?.lease?.id,
    }),
  ).toMatchObject({ reason: "identity_quarantined", subscriptionKind: "viewer" });
  h.state.quarantined = false;
  const again = await h.start();
  h.lifecycle.deviceIdentityChanged(device.deviceId);
  await flush();
  expect(again.success).toBe(true);
  expect(endings(h)).toHaveLength(1);
});
test("f: close logs shutdown once and removes every listener within the stop bound", async () => {
  const h = harness();
  await h.start();
  await flush();
  h.sources[0].stop = () => new Promise<void>(() => {});
  const closing = h.server.close();
  await flush();
  h.timer.advanceTime(5000);
  await closing;
  expect(endings(h).map(([message]) => String(message))).toEqual([
    expect.stringContaining("reason=daemon_shutdown"),
  ]);
  expect(h.ownership.size).toBe(0);
  expect(h.releases.size).toBe(0);
  expect(h.lifecycleCount()).toBe(0);
});
test("g: incarnation cleanup reports device_restored once at info with its cause", async () => {
  const h = harness();
  const first = await h.start();
  const listener = createWebRtcStreamDeviceIncarnationListener();
  await listener.prepareForIncarnationChange?.(device.deviceId);
  await listener.onDeviceIncarnationChanged(device.deviceId);
  for (const action of ["status", "await", "stop"] as const) {
    expect(
      await h.request({
        action,
        streamId: first.stream?.streamId,
        leaseId: first.stream?.lease?.id,
      }),
    ).toMatchObject({ success: false, reason: "device_restored", subscriptionKind: "viewer" });
  }
  expect(endings(h)).toHaveLength(1);
  expect(endings(h)[0][0]).toContain("reason=device_restored");
  expect(
    h.info.mock.calls.filter(([message]) => String(message).includes("incarnation change")),
  ).toHaveLength(1);
  expect(
    h.warn.mock.calls.filter(([message]) => String(message).includes("ending subscription:")),
  ).toHaveLength(0);
});
test.each(["device_removed", "identity_quarantined", "daemon_shutdown"] as const)(
  "h: auth-off ignores ownership but ends on %s",
  async (reason) => {
    const h = harness({ authOff: true });
    const first = await h.request({ action: "start", sessionUuid: undefined });
    expect(first.subscriptionKind).toBe("owner");
    h.state.live.clear();
    h.state.owner = "other";
    await h.changed();
    h.state.owner = null;
    await h.changed();
    expect(endings(h)).toHaveLength(0);
    expect(h.sources[0].stopped).toBe(false);
    if (reason === "device_removed") {
      h.lifecycle.deviceRemoved(device.deviceId);
    } else if (reason === "identity_quarantined") {
      h.state.quarantined = true;
      h.lifecycle.deviceIdentityChanged(device.deviceId);
    } else {
      await h.server.close();
    }
    await flush();
    expect(endings(h)).toHaveLength(1);
    expect(endings(h)[0][0]).toContain(`reason=${reason}`);
  },
);
test.each([undefined, "a"])(
  "post-start owner change admits/downgrades viewer (%s)",
  async (owner) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ owner, startGate: gate });
    const starting = h.start();
    await flush();
    h.state.owner = "b";
    release();
    expect(await starting).toMatchObject({ success: true, subscriptionKind: "viewer" });
    expect(manager.listWebRtcStreams()).toHaveLength(1);
    expect(h.sources[0].stopped).toBe(false);
    expect(await h.start()).toMatchObject({ success: true, subscriptionKind: "viewer" });
    expect(h.sources).toHaveLength(1);
  },
);
test("j: removal, explicit stop and shutdown race logs each end only once", async () => {
  const h = harness({ owner: "a" });
  const first = await h.start();
  h.lifecycle.deviceRemoved(device.deviceId);
  const stopping = h.request({
    action: "stop",
    streamId: first.stream?.streamId,
    leaseId: first.stream?.lease?.id,
  });
  await h.server.close();
  await stopping;
  expect(endings(h)).toHaveLength(1);
  expect(endings(h)[0][0]).toContain("reason=device_removed");
});
test("k: legacy authenticator remains fail-closed on loss of authorization", async () => {
  let reject = false;
  const h = harness({
    authenticator: {
      authorize: ({ requireOwnership }) => {
        if (requireOwnership && reject) {
          throw new Error("lost access");
        }
      },
    },
  });
  const first = await h.start();
  expect(first.subscriptionKind).toBe("owner");
  reject = true;
  await h.changed();
  expect(
    await h.request({
      action: "status",
      streamId: first.stream?.streamId,
      leaseId: first.stream?.lease?.id,
    }),
  ).toMatchObject({ reason: "session_ended", subscriptionKind: "owner" });
  expect(h.sources[0].stopped).toBe(true);
  expect(endings(h)).toHaveLength(1);
  expect(h.warn).toHaveBeenCalled();
});

test("typed viewer failures survive the actual request/response wire boundary", async () => {
  const h = harness();
  const first = await h.start();
  const socket = new FakeSocket();
  await h.server.line(socket, {
    action: "start",
    sessionUuid: "a",
    bitrateKbps: 777,
    streamId: first.stream?.streamId,
    leaseId: first.stream?.lease?.id,
  });
  await flush();
  expect(socket.getWrittenMessages()[0]).toMatchObject({
    success: false,
    errorCode: "viewer_read_only",
    subscriptionKind: "viewer",
  });
});

test("ended start is fresh admission even with another viewer lease on the same record", async () => {
  const h = harness();
  const first = await h.start();
  await h.start("b");
  h.state.live.delete("a");
  for (const cb of h.releases) {
    cb("a");
  }
  await flush();
  h.state.live.add("a");
  const again = await h.start("a", first.stream?.lease?.id);
  expect(again).toMatchObject({ success: true, subscriptionKind: "viewer" });
  expect(again.stream?.lease?.id).not.toBe(first.stream?.lease?.id);
});

test("renewing start, status and await never recompute the recorded subscription kind", async () => {
  let resolutions = 0;
  const h = harness({
    authenticator: {
      authorize: () => {},
      resolveSubscriptionIdentity: () => {
        resolutions++;
        return { authEnabled: true, sessionExists: true, ownsDevice: true };
      },
    },
  });
  const first = await h.start();
  const address = { streamId: first.stream?.streamId, leaseId: first.stream?.lease?.id };
  for (const action of ["start", "status", "await"] as const) {
    expect(await h.request({ action, ...address, readiness: "capture_ready" })).toMatchObject({
      success: true,
      subscriptionKind: "owner",
    });
  }
  expect(resolutions).toBe(3);
});

test("post-start session expiry rollback preserves another session's concurrently minted lease", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness({ startGate: gate });
  const rejected = h.start();
  await flush();
  h.state.live.delete("a");
  h.state.owner = "b";
  const admitted = h.start("b");
  await flush();
  release();
  expect(await rejected).toMatchObject({
    success: false,
    error: expect.stringContaining("unknown or expired"),
  });
  const owner = await admitted;
  expect(owner).toMatchObject({ success: true, subscriptionKind: "owner" });
  expect(manager.getWebRtcStreamDescriptor(owner.stream!.streamId)?.consumerCount).toBe(1);
  expect(h.sources[0].stopped).toBe(false);
});

test("identity resolver errors fail closed, warn, and never log the session UUID", async () => {
  let reject = false;
  const h = harness({
    authenticator: {
      authorize: () => {},
      resolveSubscriptionIdentity: () => {
        if (reject) {
          throw new Error("sensitive-session-a");
        }
        return { authEnabled: true, sessionExists: true, ownsDevice: true };
      },
    },
  });
  const first = await h.start();
  reject = true;
  await h.changed();
  expect(
    await h.request({
      action: "status",
      streamId: first.stream?.streamId,
      leaseId: first.stream?.lease?.id,
    }),
  ).toMatchObject({ reason: "session_ended", subscriptionKind: "owner" });
  expect(h.warn).toHaveBeenCalled();
  expect(JSON.stringify(h.warn.mock.calls)).not.toContain("sensitive-session-a");
});

test("leaseless stop is allowed for a caller with mixed owner/viewer leases", async () => {
  const h = harness();
  const viewer = await h.start();
  h.state.owner = "a";
  await h.changed();
  const owner = await h.start();
  expect(owner.subscriptionKind).toBe("owner");
  const stopped = await h.request({ action: "stop", streamId: viewer.stream?.streamId });
  expect(stopped).toMatchObject({ success: true, subscriptionKind: "owner" });
  expect(h.sources[0].stopped).toBe(true);
});

test("a failed start still reports the kind minted for its lease", async () => {
  const h = harness();
  manager.setWebRtcStreamManagerDependencies({
    captureRegistry: createDeviceCaptureRegistry(),
    createSource: () => ({
      start: async () => {
        throw new Error("capture unavailable");
      },
      stop: async () => {},
    }),
  });
  expect(await h.start()).toMatchObject({ success: false, subscriptionKind: "viewer" });
});

test.each(["lease", "leaseless"] as const)("fix1: unowned viewer can stop %s", async (mode) => {
  const h = harness();
  const first = await h.start();
  expect(first.subscriptionKind).toBe("viewer");
  const stopped = await h.request({
    action: "stop",
    streamId: first.stream?.streamId,
    leaseId: mode === "lease" ? first.stream?.lease?.id : undefined,
  });
  expect(stopped).toMatchObject({ success: true, stream: { state: "stopped" } });
  expect(manager.listWebRtcStreams()).toEqual([]);
  expect(h.sources[0].stopped).toBe(true);
});
test("fix1: unowned viewer renews the same lease with a new expiry", async () => {
  const h = harness();
  const first = await h.start();
  h.timer.advanceTime(1000);
  const renewed = await h.start("a", first.stream?.lease?.id);
  expect(renewed).toMatchObject({ success: true, subscriptionKind: "viewer" });
  expect(renewed.stream?.lease?.id).toBe(first.stream?.lease?.id);
  expect(
    Date.parse(renewed.stream!.lease!.expiresAt) - Date.parse(first.stream!.lease!.expiresAt),
  ).toBe(1000);
  expect(h.sources).toHaveLength(1);
});
test.each(["lease", "leaseless"] as const)(
  "fix1: downgraded viewer releases only its own %s",
  async (mode) => {
    const h = harness({ owner: "a" });
    const first = await h.start();
    h.state.owner = "b";
    await h.changed();
    const other = await h.start("b");
    const result = await h.request({
      action: "stop",
      streamId: first.stream?.streamId,
      leaseId: mode === "lease" ? first.stream?.lease?.id : undefined,
    });
    expect(result).toMatchObject({
      success: true,
      subscriptionKind: "viewer",
      stream: { consumerCount: 1 },
    });
    expect(h.sources[0].stopped).toBe(false);
    expect(
      manager.getWebRtcStreamDescriptor(other.stream!.streamId, other.stream?.lease?.id, "b")?.lease
        ?.id,
    ).toBe(other.stream?.lease?.id);
  },
);
test.each([{ whipEndpoint: "http://127.0.0.1:8000/private" }, { bitrateKbps: 777 }])(
  "fix1: viewer differing renewal is read-only: %j",
  async (overrides) => {
    const h = harness();
    const first = await h.start();
    const before = manager.getWebRtcStreamDescriptor(first.stream!.streamId);
    h.timer.advanceTime(1000);
    expect(
      await h.request({ action: "start", leaseId: first.stream?.lease?.id, ...overrides }),
    ).toMatchObject({ success: false, errorCode: "viewer_read_only" });
    // Peek through the list to avoid renewing the lease while checking side effects.
    expect(manager.listWebRtcStreams()[0].consumerCount).toBe(before?.consumerCount);
    expect(h.sources[0].stopped).toBe(false);
    h.timer.advanceTime(manager.WEBRTC_STREAM_LEASE_TTL_MS - 1000);
    expect(manager.listWebRtcStreams()).toEqual([]);
  },
);
test.each(["leaseless", "streamId", "owner lease", "regained viewer lease"] as const)(
  "fix2: owner stops surviving viewer outright: %s",
  async (mode) => {
    const h = harness({ owner: "a" });
    const first = await h.start();
    h.state.owner = "b";
    await h.changed();
    const ownerLease = mode === "owner lease" ? await h.start("b") : undefined;
    if (mode === "regained viewer lease") {
      h.state.owner = "a";
      await h.changed();
      await manager.startWebRtcStream({ device, sessionUuid: "b", subscriptionKind: "viewer" });
    }
    const stopped = await h.request({
      action: "stop",
      sessionUuid: mode === "regained viewer lease" ? "a" : "b",
      streamId: mode === "leaseless" ? undefined : first.stream?.streamId,
      leaseId:
        mode === "owner lease"
          ? ownerLease?.stream?.lease?.id
          : mode === "regained viewer lease"
            ? first.stream?.lease?.id
            : undefined,
    });
    expect(stopped).toMatchObject({ success: true, stream: { state: "stopped" } });
    expect(manager.listWebRtcStreams()).toEqual([]);
    expect(h.sources[0].stopped).toBe(true);
    expect(h.publishers[0].getState()).toBe("stopped");
    if (mode !== "regained viewer lease") {
      for (const action of ["status", "await", "stop"] as const) {
        expect(
          await h.request({
            action,
            streamId: first.stream?.streamId,
            leaseId: first.stream?.lease?.id,
          }),
        ).toMatchObject({ success: false, reason: "stopped_by_owner", subscriptionKind: "viewer" });
      }
    }
    expect(endings(h)).toHaveLength(1);
    expect(
      h.info.mock.calls.filter(([message]) => String(message).includes("ending subscription:")),
    ).toHaveLength(1);
  },
);
test.each([
  { whipEndpoint: "http://127.0.0.1:8000/private" },
  { bitrateKbps: 777 },
  { whipToken: "secret-token" },
])("owner replaces differing viewer capture: %j", async (overrides) => {
  const h = harness({ owner: "a" });
  const first = await h.start();
  h.state.owner = "b";
  await h.changed();
  const joined = await h.request({ action: "start", sessionUuid: "b", ...overrides });
  expect(joined).toMatchObject({ success: true, subscriptionKind: "owner" });
  expect(h.sources[0].stopped).toBe(true);
  expect(h.sources).toHaveLength(2);
  expect(manager.listWebRtcStreams()[0].consumerCount).toBe(1);
  expect(
    await h.request({
      action: "status",
      streamId: first.stream?.streamId,
      leaseId: first.stream?.lease?.id,
    }),
  ).toMatchObject({ success: false, reason: "stopped_by_owner" });
});
test.each([false, true])(
  "fix2: compatible owner start attaches without restart (explicit=%s)",
  async (explicit) => {
    const h = harness({ owner: "a" });
    const first = await h.start();
    h.state.owner = "b";
    await h.changed();
    const joined = await h.request({
      action: "start",
      sessionUuid: "b",
      whipEndpoint: explicit ? endpoint : undefined,
    });
    expect(joined).toMatchObject({ success: true, subscriptionKind: "owner" });
    expect(joined.stream?.streamId).toBe(first.stream?.streamId);
    expect(joined.stream?.lease?.id).not.toBe(first.stream?.lease?.id);
    expect(joined.stream?.consumerCount).toBe(2);
    expect(h.sources).toHaveLength(1);
  },
);
test("fix2: auth disabled keeps legacy stop and attach semantics", async () => {
  const h = harness({ authOff: true });
  const first = await h.start("a");
  const other = await h.request({ action: "start", sessionUuid: "b", bitrateKbps: 777 });
  expect(other).toMatchObject({ success: true });
  h.state.owner = "b";
  expect(
    await h.request({ action: "stop", sessionUuid: "b", streamId: first.stream?.streamId }),
  ).toMatchObject({ success: true, stream: { consumerCount: 1 } });
  expect(h.sources[0].stopped).toBe(false);
  expect(endings(h)).toHaveLength(0);
});
test("fix4: repeated viewer rejection warns once per lease/action and debugs the rest", async () => {
  const h = harness();
  const first = await h.start();
  for (let i = 0; i < 5; i++) {
    expect(
      await h.request({ action: "start", leaseId: first.stream?.lease?.id, bitrateKbps: 777 }),
    ).toMatchObject({ errorCode: "viewer_read_only" });
  }
  const matches = ([message]: readonly unknown[]) =>
    String(message).includes("rejected viewer control:");
  expect(h.warn.mock.calls.filter(matches)).toHaveLength(1);
  expect(h.debug.mock.calls.filter(matches)).toHaveLength(4);
});

test("compatible viewer renewal remains admitted on another session's device", async () => {
  const h = harness();
  const first = await h.start();
  h.state.owner = "b";
  await h.changed();
  h.timer.advanceTime(1000);
  const renewed = await h.start("a", first.stream?.lease?.id);
  expect(renewed).toMatchObject({ success: true, subscriptionKind: "viewer" });
  expect(renewed.stream?.lease?.id).toBe(first.stream?.lease?.id);
  expect(h.sources[0].stopped).toBe(false);
  h.timer.advanceTime(manager.WEBRTC_STREAM_LEASE_TTL_MS);
  expect(manager.listWebRtcStreams()).toEqual([]);
});

test("fix1: wire claims cannot authorize viewer parameter changes", async () => {
  const h = harness();
  const first = await h.start();
  const claims = { target: "own_lease", ownsDevice: true };
  expect(
    await h.request({
      action: "start",
      leaseId: first.stream?.lease?.id,
      bitrateKbps: 777,
      ...claims,
    }),
  ).toMatchObject({ errorCode: "viewer_read_only" });
  expect(manager.listWebRtcStreams()[0].consumerCount).toBe(1);
});

test("item3: regaining ownership leaves a downgraded lease as viewer", async () => {
  const h = harness({ owner: "a" });
  const first = await h.start();
  h.state.owner = "b";
  await h.changed();
  h.state.owner = "a";
  await h.changed();
  expect(
    await h.request({
      action: "status",
      streamId: first.stream?.streamId,
      leaseId: first.stream?.lease?.id,
    }),
  ).toMatchObject({ subscriptionKind: "viewer" });
});

test("fix4: rejection keys distinguish action/session, evict oldest, and clear on close/start", async () => {
  const timer = new FakeTimer();
  const server = new TestServer(
    "/unused/rejection-cache.sock",
    timer,
    {
      resolveDevice: async () => device,
      startStream: async () => {
        throw new Error("unexpected start");
      },
      stopStream: async () => {
        throw new Error("unexpected stop");
      },
      listStreams: () => [],
      getStream: () => null,
      getSubscriptionKind: () => "viewer",
    },
    { authorize: () => {} },
    { assertDeviceActionable: () => {} },
  );
  servers.push(server);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const debug = spyOn(logger, "debug").mockImplementation(() => {});
  spies.push(warn, debug);
  const reject = (
    leaseId: string,
    action: "stop" | "start" = "stop",
    sessionUuid = "private-session",
  ) => server.request({ action, leaseId, sessionUuid });
  await reject("0");
  await reject("0");
  expect(warn.mock.calls).toHaveLength(1);
  expect(debug.mock.calls).toHaveLength(1);
  await reject("0", "start");
  await reject("0", "stop", "other-private-session");
  expect(warn.mock.calls).toHaveLength(3);
  for (let i = 1; i <= 256; i++) {
    await reject(String(i));
  }
  await reject("0");
  expect(warn.mock.calls).toHaveLength(260);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("private-session");
  await server.close();
  server.started();
  await reject("0");
  expect(warn.mock.calls).toHaveLength(261);
});

test("fix1: addressed viewer reads and own release do not require current device ownership", async () => {
  const h = harness({ owner: "a" });
  const first = await h.start();
  h.state.owner = "b";
  await h.changed();
  const other = await h.start("b");
  const address = {
    deviceId: device.deviceId,
    streamId: first.stream?.streamId,
    leaseId: first.stream?.lease?.id,
  };
  for (const action of ["status", "await", "stop"] as const) {
    expect(await h.request({ action, ...address, readiness: "capture_ready" })).toMatchObject({
      success: true,
      subscriptionKind: "viewer",
    });
  }
  expect(manager.getWebRtcStreamDescriptor(other.stream!.streamId)?.consumerCount).toBe(1);
  expect(h.sources[0].stopped).toBe(false);
});

test.each(["missing", "unknown", "expired", "releasing", "observer"] as const)(
  "viewer admission rejects %s before capture",
  async (identity) => {
    const h = harness({ owner: "b" });
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
    const socket = new FakeSocket();
    await h.server.line(socket, { action: "start", sessionUuid, deviceId: device.deviceId });
    await flush();
    expect(socket.getWrittenMessages()[0]).toMatchObject({
      success: false,
      error: expect.stringContaining(
        identity === "missing"
          ? "authenticated daemon session"
          : identity === "releasing"
            ? "being released"
            : "unknown or expired",
      ),
    });
    expect(h.sources).toHaveLength(0);
  },
);
test.each([false, true])(
  "admitted viewer survives owner release and removal (ownership change=%s)",
  async (changeOwner) => {
    const h = harness({ owner: "b" });
    const owner = await h.start("b");
    const viewer = await h.start("a");
    expect(owner).toMatchObject({ success: true, subscriptionKind: "owner" });
    expect(viewer).toMatchObject({ success: true, subscriptionKind: "viewer" });
    if (changeOwner) {
      h.state.owner = "a";
      await h.changed();
      expect(
        await h.request({
          action: "status",
          sessionUuid: "b",
          streamId: owner.stream?.streamId,
          leaseId: owner.stream?.lease?.id,
        }),
      ).toMatchObject({ success: true, subscriptionKind: "viewer" });
      h.state.owner = "b";
      await h.changed();
    }
    h.state.live.delete("b");
    h.state.owner = null;
    for (const cb of h.releases) {
      cb("b");
    }
    await h.changed();
    const address = { streamId: viewer.stream?.streamId, leaseId: viewer.stream?.lease?.id };
    expect(await h.request({ action: "status", ...address })).toMatchObject({
      success: true,
      subscriptionKind: "viewer",
    });
    expect(h.sources[0].stopped).toBe(false);
    h.lifecycle.deviceRemoved(device.deviceId);
    await flush();
    expect(await h.request({ action: "status", ...address })).toMatchObject({
      success: false,
      reason: "device_removed",
      subscriptionKind: "viewer",
    });
    h.state.owner = "other";
    expect(await h.start("a", viewer.stream?.lease?.id)).toMatchObject({
      success: true,
      subscriptionKind: "viewer",
    });
  },
);
test("owner stop ends a newly admitted viewer with a typed wire response and allows re-admission", async () => {
  const h = harness({ owner: "b" });
  const owner = await h.start("b");
  const viewer = await h.start("a");
  expect(viewer).toMatchObject({ success: true, subscriptionKind: "viewer" });
  expect(
    await h.request({ action: "stop", sessionUuid: "b", streamId: owner.stream?.streamId }),
  ).toMatchObject({ success: true, stream: { state: "stopped" } });
  const socket = new FakeSocket();
  await h.server.line(socket, {
    action: "await",
    sessionUuid: "a",
    streamId: viewer.stream?.streamId,
    leaseId: viewer.stream?.lease?.id,
  });
  await flush();
  expect(socket.getWrittenMessages()[0]).toMatchObject({
    success: false,
    reason: "stopped_by_owner",
    subscriptionKind: "viewer",
  });
  expect(h.sources[0].stopped).toBe(true);
  expect(h.publishers[0].getState()).toBe("stopped");
  expect(await h.start("a", viewer.stream?.lease?.id)).toMatchObject({
    success: true,
    subscriptionKind: "viewer",
  });
});
test.each([false, true])(
  "new viewer overrides cannot reconfigure an owner's WebRTC capture (named=%s)",
  async (named) => {
    const h = harness({ owner: "b" });
    const owner = await h.start("b");
    const viewer = await h.request({
      action: "start",
      deviceId: named ? device.deviceId : undefined,
      bitrateKbps: 777,
      whipEndpoint: "http://127.0.0.1:8000/private",
    });
    expect(viewer).toMatchObject({ success: true, subscriptionKind: "viewer" });
    expect(viewer.stream?.streamId).toBe(owner.stream?.streamId);
    expect(viewer.stream?.whipEndpoint).toBe(owner.stream?.whipEndpoint);
    expect(h.captureHints).toHaveLength(1);
    expect(h.captureHints[0].bitrateBps).not.toBe(777000);
    expect(h.sources).toHaveLength(1);
    expect(h.publishers).toHaveLength(1);
  },
);

test("transport default admits a registered observer-only session as a viewer of an owned device (#10698)", async () => {
  const sessions = releasingSessionHarness();
  sessions.observers.register("observer", "desktop");
  expect(sessions.observers.resolveObserverScope("observer").kind).not.toBe("denied");
  const state = DaemonState.getInstance();
  const stateSpies = [
    spyOn(state, "isInitialized").mockReturnValue(true),
    spyOn(state, "getSessionManager").mockReturnValue(sessions.manager),
    spyOn(state, "getObserverSessionRegistry").mockReturnValue(sessions.observers),
    // An agent holds the device; the observer holds nothing at all.
    spyOn(sessions.manager, "getSessionForDevice").mockReturnValue("agent-session"),
  ];
  const previousAuth = process.env.AUTOMOBILE_DAEMON_STREAM_AUTH;
  process.env.AUTOMOBILE_DAEMON_STREAM_AUTH = "1";
  try {
    const h = harness({ useDefaultAuthenticator: true });
    const socket = new FakeSocket();
    await h.server.line(socket, {
      action: "start",
      sessionUuid: "observer",
      deviceId: device.deviceId,
    });
    await flush();
    expect(socket.getWrittenMessages()[0]).toMatchObject({ success: true });
    expect(h.sources).toHaveLength(1);

    const stranger = new FakeSocket();
    await h.server.line(stranger, {
      action: "start",
      sessionUuid: "stranger",
      deviceId: device.deviceId,
    });
    await flush();
    expect(stranger.getWrittenMessages()[0]).toMatchObject({
      success: false,
      error: expect.stringContaining("unknown or expired"),
    });
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

test("viewer-first WebRTC overrides are ignored", async () => {
  const h = harness({ owner: "b" });
  const viewer = await h.request({
    action: "start",
    whipEndpoint: "http://127.0.0.1:8000/private",
    bitrateKbps: 777,
    androidFps: 7,
  });
  expect(viewer).toMatchObject({ success: true, subscriptionKind: "viewer" });
  expect(viewer.stream?.whipEndpoint).toBe(endpoint);
  expect(h.captureHints[0].bitrateBps).not.toBe(777000);
  expect(h.captureHints[0].fps).not.toBe(7);
});
test("viewer-first WebRTC cannot block owner parameters", async () => {
  const h = harness({ owner: "b" });
  const viewer = await h.start("a");
  const owner = await h.request({
    action: "start",
    sessionUuid: "b",
    whipEndpoint: "http://127.0.0.1:8000/owner",
    bitrateKbps: 888,
    androidFps: 8,
  });
  expect(owner).toMatchObject({ success: true, subscriptionKind: "owner" });
  expect(owner.stream?.whipEndpoint).toBe("http://127.0.0.1:8000/owner");
  expect(h.captureHints.at(-1)).toMatchObject({ bitrateBps: 888000, fps: 8 });
  expect(h.sources[0].stopped).toBe(true);
  expect(
    await h.request({
      action: "status",
      streamId: viewer.stream?.streamId,
      leaseId: viewer.stream?.lease?.id,
    }),
  ).toMatchObject({ success: false, reason: "stopped_by_owner" });
});

test("device owner renewing a viewer lease can replace capture parameters", async () => {
  const h = harness({ owner: "b" });
  const viewer = await h.start("a");
  h.state.owner = "a";
  await h.changed();
  const owner = await h.request({
    action: "start",
    leaseId: viewer.stream?.lease?.id,
    bitrateKbps: 999,
  });
  expect(owner).toMatchObject({ success: true, subscriptionKind: "owner" });
  expect(h.captureHints.at(-1)?.bitrateBps).toBe(999000);
  expect(h.sources[0].stopped).toBe(true);
});
