import { streamSubscribeAuthCases } from "../helpers/streamSubscribeAuthCases";
import { ObserverAdmittingStreamAuthenticator } from "../../src/daemon/streamSocketAuth";
import { ObserverSessionRegistry } from "../../src/daemon/observerSessionRegistry";
import { describe, it, expect, beforeAll, beforeEach, afterEach, spyOn } from "bun:test";
import { Socket } from "node:net";
import {
  DeviceDataStreamSocketServer,
  installDeviceDataStreamSocketServerForTesting,
  type InitialFrameSubscriber,
  type NavigationGraphStreamData,
  type RequestedObservation,
} from "../../src/daemon/deviceDataStreamSocketServer";
import {
  OBSERVATION_BATCH_HEADROOM_MS,
  PER_DEVICE_OBSERVATION_TIMEOUT_MS,
  runObservationRequestBatch,
} from "../../src/daemon/observationRequestBatch";
import {
  pushInitialObservationFramesForSubscriber,
  type ObservationStreamAndroidClient,
} from "../../src/daemon/observationInitialFrame";
import { DefaultObservationInitialFrameCoordinator } from "../../src/daemon/observationInitialFrameCoordinator";
import type { ObserveResult, ViewHierarchyResult } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeDeviceSessionResolver } from "../fakes/FakeDeviceSessionResolver";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { createRegistryDeviceSessionResolver } from "../../src/daemon/deviceSessionResolver";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import {
  SessionScopedStreamAuthenticator,
  type StreamSocketAuthenticator,
} from "../../src/daemon/streamSocketAuth";
import { loadCoordinateMappingVectors } from "../parity/coordinateMappingGoldenVectors";
import { loadSharp } from "../../src/utils/image/loadSharp";
import {
  createDisplayCacheInvalidator,
  DisplayTransitionTracker,
} from "../../src/features/observe/DisplayTransition";

/** Deterministic deviceSessionUuid the harness mints for a given serial. */
function sessionUuidFor(deviceId: string): string {
  return `session-${deviceId}`;
}

/**
 * Test helper that wraps DeviceDataStreamSocketServer to allow injecting fake sockets
 * without requiring real network connections.
 *
 * The device-session routing key (epic #5256, item 3) is transparent to existing
 * device-scoped tests: `simulateSubscription({ deviceId })` mints a deterministic
 * `deviceSessionUuid` for that serial, binds it in the shared resolver, and keys the
 * subscription on it — so a `pushHierarchyUpdate(deviceId, ...)` resolves to the same
 * uuid and routes correctly without every test naming a uuid.
 */
class TestableDeviceDataStreamSocketServer extends DeviceDataStreamSocketServer {
  readonly sessionResolver = new FakeDeviceSessionResolver();

  constructor(
    timer: FakeTimer,
    authenticator: StreamSocketAuthenticator = { authorize: () => {} },
  ) {
    super("/fake/path/test.sock", timer, authenticator);
    this.setDeviceSessionResolver(this.sessionResolver);
  }

  async startFake(): Promise<void> {
    (this as any).server = { listening: true };
    (this as any).onServerStarted();
  }

  async closeFake(): Promise<void> {
    (this as any).onServerClosing();
    (this as any).server = null;
  }

  simulateSubscription(options: {
    deviceId?: string;
    deviceSessionUuid?: string | null;
    screenshotIntervalMs?: number | null;
    hierarchyIntervalMs?: number | null;
  }): { socket: FakeSocket; subscriptionId: string } {
    const socket = new FakeSocket();
    const subscriptionId = `devicedatastream-${++(this as any).subscriptionCounter}`;
    const timer = (this as any).timer as FakeTimer;
    // Bind serial↔uuid so pushes for this device resolve to the same key we filter on.
    let deviceSessionUuid: string | null;
    if (options.deviceSessionUuid !== undefined) {
      deviceSessionUuid = options.deviceSessionUuid;
    } else if (options.deviceId) {
      deviceSessionUuid = sessionUuidFor(options.deviceId);
      this.sessionResolver.bind(options.deviceId, deviceSessionUuid);
    } else {
      deviceSessionUuid = null;
    }
    this.subscribers.set(subscriptionId, {
      socket: socket as unknown as Socket,
      subscriptionId,
      lastActivity: timer.now(),
      filter: {
        deviceSessionUuid,
        deviceId: options.deviceId ?? null,
        screenshotIntervalMs: options.screenshotIntervalMs ?? null,
        hierarchyIntervalMs: options.hierarchyIntervalMs ?? null,
      },
      backfilling: false,
      drainPending: false,
    });
    return { socket, subscriptionId };
  }

  async processLineForTest(socket: FakeSocket, line: string): Promise<void> {
    await this.processLine(socket as unknown as Socket, line);
  }

  closeConnectionForTest(socket: FakeSocket): void {
    this.onConnectionClose(socket as unknown as Socket);
  }

  errorConnectionForTest(socket: FakeSocket): void {
    this.onConnectionError(socket as unknown as Socket, new Error("socket error"));
  }
}

describe("DeviceDataStreamSocketServer", () => {
  let server: TestableDeviceDataStreamSocketServer;
  let timer: FakeTimer;
  let encodedFrames: { jpeg: Buffer; webp: Buffer };

  beforeAll(async () => {
    const sharp = await loadSharp();
    const pixels = Buffer.alloc(37 * 53 * 3, 127);
    encodedFrames = {
      jpeg: await sharp(pixels, { raw: { width: 37, height: 53, channels: 3 } })
        .jpeg()
        .toBuffer(),
      webp: await sharp(pixels, { raw: { width: 37, height: 53, channels: 3 } })
        .webp()
        .toBuffer(),
    };
  });

  beforeEach(async () => {
    timer = new FakeTimer();
    server = new TestableDeviceDataStreamSocketServer(timer);
    await server.startFake();
  });

  afterEach(() => {
    installDeviceDataStreamSocketServerForTesting(null);
  });

  function initialFrameHarness(
    options: {
      deviceId?: string;
      coordinator?: DefaultObservationInitialFrameCoordinator;
    } = {},
  ) {
    const coordinator =
      options.coordinator ??
      new DefaultObservationInitialFrameCoordinator(
        timer,
        2,
        (id) => server.getLiveFrameGeneration(id),
        (id) => server.getDeviceSessionUuid(id),
      );
    const device = {
      id: options.deviceId ?? "device-1",
      name: "Pixel",
      platform: "android" as const,
    };
    let captures = 0;
    const recordedSequences: Array<number | null> = [];
    let context = "ctx-a";
    let screenshot: () => Promise<void> = async () => {};
    let connect: () => Promise<boolean> = async () => true;
    const hierarchy = (text: string): ViewHierarchyResult => ({
      hierarchy: { node: { $: { class: "Root", text } } },
      screenWidth: 37,
      screenHeight: 53,
    });
    const request = (subscriptionId: string) =>
      pushInitialObservationFramesForSubscriber(device.id, [device], {
        streamServer: server,
        coordinator,
        subscriber: { subscriptionId, signal: new AbortController().signal },
        androidClientFactory: () => {
          captures++;
          const capturedContext = context;
          const client: ObservationStreamAndroidClient = {
            ensureConnected: () => connect(),
            getLatestHierarchy: async () => ({
              hierarchy: { hierarchy: {}, updatedAt: 1 },
              fresh: true,
              frameContext: capturedContext,
            }),
            requestHierarchySyncWithoutObservationStreamPush: async () => null,
            convertToViewHierarchyResult: () => hierarchy(capturedContext),
            recordInitialObservationStreamHierarchy: (_hierarchy, sequence) => {
              recordedSequences.push(sequence);
            },
            captureScreenshotForObservationStream: async () => {
              await screenshot();
              return {
                success: true,
                data: encodedFrames.jpeg.toString("base64"),
                frameContext: capturedContext,
              };
            },
          };
          return client;
        },
        iosClientFactory: () => {
          throw new Error("unexpected iOS");
        },
      });
    const frames = (socket: FakeSocket) =>
      socket.getWrittenMessages<{
        type: string;
        frameContext?: string;
        captureSequence?: number;
        deviceSessionUuid?: string | null;
        hierarchyDiff?: { hasBaseline: boolean; changed: number };
      }>();
    return {
      coordinator,
      request,
      frames,
      hierarchy,
      recordedSequences,
      get captures() {
        return captures;
      },
      setContext: (value: string) => {
        context = value;
      },
      setConnection: (value: typeof connect) => {
        connect = value;
      },
      setScreenshot: (value: typeof screenshot) => {
        screenshot = value;
      },
    };
  }

  function displayTracker(): DisplayTransitionTracker {
    installDeviceDataStreamSocketServerForTesting(server);
    return new DisplayTransitionTracker(createDisplayCacheInvalidator());
  }

  it("display transition clears the pre-transition hierarchy diff baseline", () => {
    const h = initialFrameHarness();
    const pane = server.simulateSubscription({ deviceId: "device-1" });
    server.pushHierarchyUpdate("device-1", h.hierarchy("inner"), "inner");
    server.pushHierarchyUpdate("device-1", h.hierarchy("inner"), "inner");
    expect(h.frames(pane.socket).at(-1)?.hierarchyDiff?.hasBaseline).toBe(true);

    displayTracker().notifyTransition("device-1", "fold to cover");
    server.pushHierarchyUpdate("device-1", h.hierarchy("cover"), "cover");
    expect(h.frames(pane.socket).at(-1)?.hierarchyDiff?.hasBaseline).toBe(false);
  });

  it("display transition prevents replay of a cached pre-transition initial frame", async () => {
    const h = initialFrameHarness();
    const first = server.simulateSubscription({ deviceId: "device-1" });
    await h.request(first.subscriptionId);
    expect(h.frames(first.socket).map((frame) => frame.frameContext)).toEqual(["ctx-a", "ctx-a"]);
    timer.advanceTime(1);

    displayTracker().notifyTransition("device-1", "fold to cover");
    h.setContext("cover");
    const next = server.simulateSubscription({ deviceId: "device-1" });
    await h.request(next.subscriptionId);
    expect(h.captures).toBe(2);
    expect(h.frames(next.socket).map((frame) => frame.frameContext)).toEqual(["cover", "cover"]);
  });

  it("display transition discards an initial capture already in flight", async () => {
    const h = initialFrameHarness();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    h.setScreenshot(async () => {
      started.resolve();
      await finish.promise;
    });
    const pane = server.simulateSubscription({ deviceId: "device-1" });
    const capture = h.request(pane.subscriptionId);
    await started.promise;
    displayTracker().notifyTransition("device-1", "fold to cover");
    const context = server.getCurrentFrameContext("device-1");
    finish.resolve();
    await capture;
    expect(h.frames(pane.socket)).toEqual([]);
    expect(h.recordedSequences).toEqual([]);
    expect(server.getCurrentFrameContext("device-1")).toBe(context);

    h.setScreenshot(async () => {});
    h.setContext("cover");
    const next = server.simulateSubscription({ deviceId: "device-1" });
    await h.request(next.subscriptionId);
    expect(h.captures).toBe(2);
    expect(h.frames(next.socket).map((frame) => frame.frameContext)).toEqual(["cover", "cover"]);
  });

  it("display transition on A preserves B's cached initial frame and diff baseline", async () => {
    const a = initialFrameHarness();
    const b = initialFrameHarness({ deviceId: "device-2", coordinator: a.coordinator });
    b.setContext("other-panel");
    const firstA = server.simulateSubscription({ deviceId: "device-1" });
    const firstB = server.simulateSubscription({ deviceId: "device-2" });
    await a.request(firstA.subscriptionId);
    await b.request(firstB.subscriptionId);
    timer.advanceTime(1);
    const generationB = server.getLiveFrameGeneration("device-2");

    displayTracker().notifyTransition("device-1", "fold to cover");
    a.setContext("cover");
    b.setContext("should-not-be-captured");
    const nextA = server.simulateSubscription({ deviceId: "device-1" });
    const nextB = server.simulateSubscription({ deviceId: "device-2" });
    await a.request(nextA.subscriptionId);
    await b.request(nextB.subscriptionId);
    expect(a.captures).toBe(2);
    expect(b.captures).toBe(1);
    expect(server.getLiveFrameGeneration("device-2")).toBe(generationB);
    expect(b.frames(nextB.socket).map((frame) => frame.frameContext)).toEqual([
      "other-panel",
      "other-panel",
    ]);
    server.pushHierarchyUpdate("device-2", b.hierarchy("other-panel"), "other-panel");
    expect(b.frames(firstB.socket).at(-1)?.hierarchyDiff?.hasBaseline).toBe(true);
    expect(a.frames(nextA.socket).map((frame) => frame.frameContext)).toEqual(["cover", "cover"]);
  });

  const frameInvalidations = [
    {
      name: "connection loss",
      invalidate: () => server.onDeviceConnectionLost("device-1"),
    },
    {
      name: "session replacement",
      invalidate: () => {
        server.sessionResolver.bind("device-1", "successor-session");
        server.pushDeviceSessionEnded(
          {
            deviceId: "device-1",
            deviceSessionUuid: "session-device-1",
            platform: "android",
            epochStartedAt: 0,
          },
          { successorSessionUuid: "successor-session" },
        );
        server.pushDeviceSessionStarted({
          deviceId: "device-1",
          deviceSessionUuid: "successor-session",
          platform: "android",
          epochStartedAt: 0,
        });
      },
    },
    {
      name: "resolver replacement",
      invalidate: () => server.setDeviceSessionResolver(server.sessionResolver),
    },
    {
      name: "session retirement",
      invalidate: () => {
        server.sessionResolver.retire("device-1");
        server.pushDeviceSessionEnded({
          deviceId: "device-1",
          deviceSessionUuid: "session-device-1",
          platform: "android",
          epochStartedAt: 0,
        });
      },
    },
    {
      name: "session start",
      invalidate: () =>
        server.pushDeviceSessionStarted({
          deviceId: "device-1",
          deviceSessionUuid: "session-device-1",
          platform: "android",
          epochStartedAt: 0,
        }),
    },
    {
      name: "resolver-only rebind",
      invalidate: () => server.sessionResolver.bind("device-1", "successor-session"),
    },
  ];

  it("reading generations does not retain capture-only serials", () => {
    const generations = (server as unknown as { liveFrameGenerations: ReadonlyMap<string, number> })
      .liveFrameGenerations;
    const size = generations.size;
    server.getLiveFrameGeneration("never-pushed-1");
    server.getLiveFrameGeneration("never-pushed-2");
    expect(generations.size).toBe(size);
  });

  it("resolver replacement fences a capture-only serial without retaining its generation", async () => {
    const h = initialFrameHarness();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    h.setScreenshot(async () => {
      started.resolve();
      await finish.promise;
    });
    const pane = server.simulateSubscription({ deviceSessionUuid: null });
    server.sessionResolver.bind("device-1", "session-device-1");
    const first = h.request(pane.subscriptionId);
    await started.promise;
    server.setDeviceSessionResolver(server.sessionResolver);
    finish.resolve();
    await first;
    expect(h.frames(pane.socket)).toEqual([]);
    expect(
      (
        server as unknown as { liveFrameGenerations: ReadonlyMap<string, number> }
      ).liveFrameGenerations.has("device-1"),
    ).toBe(false);
  });

  for (const event of frameInvalidations) {
    it(`drops an in-flight initial frame after ${event.name} and recaptures without caching it`, async () => {
      const h = initialFrameHarness();
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      h.setScreenshot(async () => {
        started.resolve();
        await finish.promise;
      });
      const a = server.simulateSubscription({ deviceSessionUuid: null });
      server.sessionResolver.bind("device-1", "session-device-1");
      const first = h.request(a.subscriptionId);
      await started.promise;
      event.invalidate();
      finish.resolve();
      await first;
      expect(h.frames(a.socket).filter((frame) => frame.type.endsWith("_update"))).toEqual([]);
      expect(server.getCurrentFrameContext("device-1")).toBeUndefined();
      h.setContext("ctx-fresh");
      h.setScreenshot(async () => {});
      const b = server.simulateSubscription({ deviceSessionUuid: null });
      await h.request(b.subscriptionId);
      expect(h.captures).toBe(2);
      expect(h.frames(b.socket).map((frame) => frame.frameContext)).toEqual([
        "ctx-fresh",
        "ctx-fresh",
      ]);
      expect(h.frames(b.socket).map((frame) => frame.deviceSessionUuid)).toEqual([
        server.sessionResolver.resolveUuid("device-1"),
        server.sessionResolver.resolveUuid("device-1"),
      ]);
    });

    it(`recaptures a cached initial frame within 1 s after ${event.name}`, async () => {
      const h = initialFrameHarness();
      const a = server.simulateSubscription({ deviceSessionUuid: null });
      server.sessionResolver.bind("device-1", "session-device-1");
      await h.request(a.subscriptionId);
      event.invalidate();
      h.setContext("ctx-fresh");
      const b = server.simulateSubscription({ deviceSessionUuid: null });
      await h.request(b.subscriptionId);
      expect(h.captures).toBe(2);
      expect(h.frames(b.socket).map((frame) => frame.frameContext)).toEqual([
        "ctx-fresh",
        "ctx-fresh",
      ]);
      expect(h.frames(b.socket).map((frame) => frame.deviceSessionUuid)).toEqual([
        server.sessionResolver.resolveUuid("device-1"),
        server.sessionResolver.resolveUuid("device-1"),
      ]);
    });
  }

  it("binds the session before connection setup and drops a rebind during ensureConnected", async () => {
    const h = initialFrameHarness();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<boolean>();
    h.setConnection(() => {
      started.resolve();
      return finish.promise;
    });
    server.sessionResolver.bind("device-1", "old-session");
    const a = server.simulateSubscription({ deviceSessionUuid: null });
    const first = h.request(a.subscriptionId);
    await started.promise;
    server.sessionResolver.bind("device-1", "new-session");
    finish.resolve(true);
    await first;
    expect(h.frames(a.socket)).toEqual([]);
    h.setConnection(async () => true);
    h.setContext("ctx-new-session");
    const b = server.simulateSubscription({ deviceSessionUuid: null });
    await h.request(b.subscriptionId);
    expect(h.captures).toBe(2);
    expect(h.frames(b.socket).map((frame) => frame.deviceSessionUuid)).toEqual([
      "new-session",
      "new-session",
    ]);
  });

  it("recaptures for a subscription arriving after connection loss while the old capture is still in flight", async () => {
    const h = initialFrameHarness();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    h.setScreenshot(async () => {
      started.resolve();
      await finish.promise;
    });
    const a = server.simulateSubscription({ deviceId: "device-1" });
    const first = h.request(a.subscriptionId);
    await started.promise;
    server.onDeviceConnectionLost("device-1");
    h.setContext("ctx-fresh");
    h.setScreenshot(async () => {});
    const b = server.simulateSubscription({ deviceId: "device-1" });
    const next = h.request(b.subscriptionId);
    expect(h.captures).toBe(1);
    finish.resolve();
    await Promise.all([first, next]);
    expect(h.captures).toBe(2);
    expect(h.frames(b.socket).map((frame) => frame.frameContext)).toEqual([
      "ctx-fresh",
      "ctx-fresh",
    ]);
    expect(
      h
        .frames(a.socket)
        .filter((frame) => frame.type.endsWith("_update"))
        .map((frame) => frame.frameContext),
    ).toEqual(["ctx-fresh", "ctx-fresh"]);
  });

  it("recaptures after a live hierarchy supersedes the cached initial frame", async () => {
    const h = initialFrameHarness();
    const a = server.simulateSubscription({ deviceId: "device-1" });
    await h.request(a.subscriptionId);
    // A received initial sequence 1; its latest live frame is now sequence 4.
    server.pushHierarchyUpdate("device-1", h.hierarchy("ctx-b"), "ctx-b");
    server.pushHierarchyUpdate("device-1", h.hierarchy("ctx-b"), "ctx-b");
    server.pushHierarchyUpdate("device-1", h.hierarchy("ctx-b"), "ctx-b");
    expect(h.frames(a.socket).at(-1)?.captureSequence).toBe(4);
    h.setContext("ctx-b");
    const b = server.simulateSubscription({ deviceId: "device-1" });
    await h.request(b.subscriptionId);
    expect(h.frames(b.socket).map((frame) => frame.frameContext)).toEqual(["ctx-b", "ctx-b"]);
    expect(h.captures).toBe(2);
    expect(server.getCurrentFrameContext("device-1")).toBe("ctx-b");
  });

  it("recaptures after a live screenshot supersedes the cached initial frame", async () => {
    const h = initialFrameHarness();
    const a = server.simulateSubscription({ deviceId: "device-1" });
    await h.request(a.subscriptionId);
    server.pushScreenshotUpdate("device-1", encodedFrames.jpeg.toString("base64"), 37, 53);
    h.setContext("ctx-b");
    const b = server.simulateSubscription({ deviceId: "device-1" });
    await h.request(b.subscriptionId);
    expect(h.frames(b.socket).map((frame) => frame.frameContext)).toEqual(["ctx-b", "ctx-b"]);
    expect(h.captures).toBe(2);
  });

  it("drops joined captures superseded by a live push and does not cache their late result", async () => {
    const h = initialFrameHarness();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    h.setScreenshot(async () => {
      started.resolve();
      await finish.promise;
    });
    const a = server.simulateSubscription({ deviceId: "device-1" });
    const first = h.request(a.subscriptionId);
    await started.promise;
    const b = server.simulateSubscription({ deviceId: "device-1" });
    const joined = h.request(b.subscriptionId);
    server.pushHierarchyUpdate("device-1", h.hierarchy("ctx-b"), "ctx-b");
    finish.resolve();
    await Promise.all([first, joined]);
    expect(h.frames(a.socket).map((frame) => frame.frameContext)).toEqual(["ctx-b"]);
    expect(h.frames(b.socket).map((frame) => frame.frameContext)).toEqual(["ctx-b"]);
    h.setContext("ctx-b");
    h.setScreenshot(async () => {});
    const c = server.simulateSubscription({ deviceId: "device-1" });
    await h.request(c.subscriptionId);
    expect(h.captures).toBe(2);
    expect(h.frames(c.socket).map((frame) => frame.frameContext)).toEqual(["ctx-b", "ctx-b"]);
  });

  it("broadcasts fresh initial captures so existing subscribers keep valid input and diff baselines", async () => {
    const h = initialFrameHarness();
    const a = server.simulateSubscription({ deviceId: "device-1" });
    const foreign = server.simulateSubscription({ deviceId: "device-2" });
    await h.request(a.subscriptionId);
    timer.advanceTime(1_000);
    h.setContext("ctx-b");
    const b = server.simulateSubscription({ deviceId: "device-1" });
    await h.request(b.subscriptionId);
    expect(h.frames(a.socket).map((frame) => frame.frameContext)).toEqual([
      "ctx-a",
      "ctx-a",
      "ctx-b",
      "ctx-b",
    ]);
    expect(h.frames(a.socket).at(-1)?.frameContext).toBe(server.getCurrentFrameContext("device-1"));
    expect(h.frames(b.socket).map((frame) => frame.frameContext)).toEqual(["ctx-b", "ctx-b"]);
    expect(h.frames(foreign.socket)).toHaveLength(0);
    server.pushHierarchyUpdate("device-1", h.hierarchy("ctx-b"), "ctx-b");
    expect(h.frames(a.socket).at(-1)?.hierarchyDiff).toEqual({
      hasBaseline: true,
      added: 0,
      changed: 0,
      removed: 0,
    });
    const c = server.simulateSubscription({ deviceId: "device-1" });
    h.setContext("ctx-c");
    // The live push invalidated the cache; a fresh frame must reach every entitled pane once.
    await h.request(c.subscriptionId);
    expect(h.frames(a.socket).at(-1)?.frameContext).toBe("ctx-c");
    const aCount = h.frames(a.socket).length;
    const d = server.simulateSubscription({ deviceId: "device-1" });
    await h.request(d.subscriptionId);
    expect(h.captures).toBe(3);
    expect(h.frames(a.socket)).toHaveLength(aCount);
    expect(h.frames(d.socket).map((frame) => frame.frameContext)).toEqual(["ctx-c", "ctx-c"]);
  });

  it("broadcasts fresh initial frames and targets replays with live session checks", async () => {
    const targets: InitialFrameSubscriber[] = [];
    server.setOnSubscriberConnected((_deviceId, subscriber) => targets.push(subscriber));
    server.sessionResolver.bind("device-1", sessionUuidFor("device-1"));
    server.sessionResolver.bind("device-2", sessionUuidFor("device-2"));
    const all = new FakeSocket();
    const first = new FakeSocket();
    const second = new FakeSocket();
    await server.processLineForTest(all, JSON.stringify({ command: "subscribe" }));
    await server.processLineForTest(
      first,
      JSON.stringify({ command: "subscribe", deviceSessionUuid: sessionUuidFor("device-1") }),
    );
    await server.processLineForTest(
      second,
      JSON.stringify({ command: "subscribe", deviceSessionUuid: sessionUuidFor("device-1") }),
    );
    const hierarchy = { hierarchy: { node: {} }, updatedAt: 123, packageName: "app" };
    const sequence = server.pushHierarchyUpdate("device-1", hierarchy, "frame-a", targets[1]);
    server.pushScreenshotUpdate(
      "device-1",
      "shot",
      100,
      200,
      {},
      { initialFrameSubscriber: targets[1] },
    );
    expect(sequence).not.toBeNull();
    expect(
      first
        .getWrittenMessages<{ type: string; deviceId?: string; captureSequence?: number }>()
        .filter((message) => message.type === "hierarchy_update"),
    ).toHaveLength(1);
    expect(
      first
        .getWrittenMessages<{ type: string; deviceId?: string; captureSequence?: number }>()
        .filter((message) => message.type === "screenshot_update"),
    ).toHaveLength(1);
    expect(
      all
        .getWrittenMessages<{ type: string; deviceId?: string; captureSequence?: number }>()
        .filter((message) => message.type === "hierarchy_update"),
    ).toHaveLength(1);
    expect(
      second
        .getWrittenMessages<{ type: string; deviceId?: string; captureSequence?: number }>()
        .filter((message) => message.type === "screenshot_update"),
    ).toHaveLength(1);
    expect(server.pushHierarchyUpdate("device-2", hierarchy, "foreign", targets[1])).toBeNull();
    server.pushScreenshotUpdate(
      "device-2",
      "shot",
      100,
      200,
      {},
      { initialFrameSubscriber: targets[1] },
    );
    expect(
      first
        .getWrittenMessages<{ type: string; deviceId?: string; captureSequence?: number }>()
        .filter((message) => message.deviceId === "device-2"),
    ).toHaveLength(0);
    server.pushHierarchyUpdate("device-1", hierarchy, "live-frame");
    server.pushHierarchyUpdate("device-1", hierarchy, "frame-a", { ...targets[1], replay: true });
    expect(server.getCurrentFrameContext("device-1")).toBe("live-frame");
    const sameSequence = server.pushHierarchyUpdate("device-1", hierarchy, "frame-a", {
      ...targets[2],
      replay: true,
      captureSequence: sequence ?? undefined,
    });
    expect(sameSequence).toBe(sequence);
    const generation = server.getCurrentFrameContextGeneration("device-1");
    server.pushHierarchyUpdate("device-1", hierarchy, "newer-live-frame");
    server.pushHierarchyUpdate("device-1", hierarchy, "delayed-initial-frame", {
      ...targets[2],
      frameContextGeneration: generation,
    });
    expect(server.getCurrentFrameContext("device-1")).toBe("newer-live-frame");
    // Rebinding the serial to a new session cannot give the old pane an initial frame.
    server.sessionResolver.bind("device-1", "new-epoch");
    expect(server.pushHierarchyUpdate("device-1", hierarchy, "new", targets[1])).toBeNull();
    server.pushScreenshotUpdate(
      "device-1",
      "shot",
      100,
      200,
      {},
      { initialFrameSubscriber: targets[1] },
    );
    expect(
      first
        .getWrittenMessages<{ type: string; deviceId?: string; captureSequence?: number }>()
        .filter((message) => message.type === "screenshot_update"),
    ).toHaveLength(1);
  });

  it("delivers the coalesced screenshot after the first subscriber is removed during hierarchy push", async () => {
    const h = initialFrameHarness();
    const first = server.simulateSubscription({ deviceId: "device-1" });
    const second = server.simulateSubscription({ deviceId: "device-1" });
    const pushHierarchy = server.pushHierarchyUpdate.bind(server);
    const hierarchyPush = spyOn(server, "pushHierarchyUpdate").mockImplementation((...args) => {
      const sequence = pushHierarchy(...args);
      server.closeConnectionForTest(first.socket);
      return sequence;
    });
    try {
      await Promise.all([h.request(first.subscriptionId), h.request(second.subscriptionId)]);
      expect(h.captures).toBe(1);
      expect(hierarchyPush).toHaveBeenCalledTimes(1);
      const hierarchies = h.frames(second.socket).filter((f) => f.type === "hierarchy_update");
      const screenshots = h.frames(second.socket).filter((f) => f.type === "screenshot_update");
      expect(hierarchies).toHaveLength(1);
      expect(screenshots).toHaveLength(1);
      expect(screenshots[0].captureSequence).toBe(hierarchies[0].captureSequence);
      expect(h.recordedSequences).toEqual([hierarchies[0].captureSequence]);
      expect(h.frames(first.socket).filter((f) => f.type === "screenshot_update")).toHaveLength(0);
    } finally {
      hierarchyPush.mockRestore();
    }
  });

  it("aborts only removed initial-frame waiters on unsubscribe and socket disconnect", async () => {
    const targets: InitialFrameSubscriber[] = [];
    server.setOnSubscriberConnected((_deviceId, subscriber) => targets.push(subscriber));
    const first = new FakeSocket();
    const second = new FakeSocket();
    await server.processLineForTest(first, JSON.stringify({ command: "subscribe" }));
    await server.processLineForTest(second, JSON.stringify({ command: "subscribe" }));
    await server.processLineForTest(
      first,
      JSON.stringify({ command: "unsubscribe", subscriptionId: targets[0].subscriptionId }),
    );
    expect(targets[0].signal.aborted).toBe(true);
    expect(targets[1].signal.aborted).toBe(false);
    const hierarchy = { hierarchy: { node: {} }, updatedAt: 123, packageName: "app" };
    expect(server.pushHierarchyUpdate("device", hierarchy, undefined, targets[0])).toBeNull();
    server.closeConnectionForTest(second);
    expect(targets[1].signal.aborted).toBe(true);
    server.pushScreenshotUpdate(
      "device",
      "shot",
      100,
      200,
      {},
      { initialFrameSubscriber: targets[1] },
    );
    expect(
      second
        .getWrittenMessages<{ type: string; deviceId?: string; captureSequence?: number }>()
        .filter((message) => message.type === "screenshot_update"),
    ).toHaveLength(0);
  });

  it("records a device-authored frame context even without an IDE subscriber", () => {
    server.pushHierarchyUpdate(
      "device-1",
      {
        updatedAt: 123,
        packageName: "com.example.app",
        hierarchy: { text: "Home" },
      } as any,
      "frame-A",
    );

    expect(server.getCurrentFrameContext("device-1")).toBe("frame-A");
  });

  it("clears a device frame context when a hierarchy has no proven context", () => {
    const hierarchy = {
      updatedAt: 123,
      packageName: "com.example.app",
      hierarchy: { text: "Home" },
    } as any;
    server.pushHierarchyUpdate("device-1", hierarchy, "frame-A");
    server.pushHierarchyUpdate("device-1", hierarchy);

    expect(server.getCurrentFrameContext("device-1")).toBeUndefined();
  });

  describe("request_observation", () => {
    const requestedObservation = (
      deviceId: string,
      frameContext?: string,
    ): RequestedObservation => ({
      deviceId,
      observation: {
        updatedAt: "2026-06-24T00:00:00.000Z",
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        viewHierarchy: {
          updatedAt: 123,
          packageName: "com.example.app",
          hierarchy: { text: "Home" },
          ...(frameContext === undefined ? {} : { frameContext }),
        } as any,
      },
    });

    it("drops an explicit observation captured across connection loss", async () => {
      const capture = Promise.withResolvers<RequestedObservation[]>();
      const started = Promise.withResolvers<void>();
      server.setOnObservationRequested(() => {
        started.resolve();
        return capture.promise;
      });
      const { socket } = server.simulateSubscription({ deviceId: "emulator-5554" });
      const request = server.processLineForTest(
        socket,
        JSON.stringify({ command: "request_observation", deviceId: "emulator-5554" }),
      );
      await started.promise;
      server.onDeviceConnectionLost("emulator-5554");
      capture.resolve([requestedObservation("emulator-5554", "pre-disconnect")]);
      await request;
      expect(server.getCurrentFrameContext("emulator-5554")).toBeUndefined();
      expect(
        socket.getWrittenMessages<{ type: string }>().filter((m) => m.type === "hierarchy_update"),
      ).toEqual([]);
    });

    it("resolver replacement fences a first explicit observation without prior device frames", async () => {
      const capture = Promise.withResolvers<RequestedObservation[]>();
      const started = Promise.withResolvers<void>();
      server.setOnObservationRequested(() => {
        started.resolve();
        return capture.promise;
      });
      const { socket } = server.simulateSubscription({ deviceId: "emulator-5554" });
      const request = server.processLineForTest(
        socket,
        JSON.stringify({ command: "request_observation", deviceId: "emulator-5554" }),
      );
      await started.promise;
      server.setDeviceSessionResolver(server.sessionResolver);
      capture.resolve([requestedObservation("emulator-5554", "pre-resolver")]);
      await request;
      expect(server.getCurrentFrameContext("emulator-5554")).toBeUndefined();
      expect(
        socket.getWrittenMessages<{ type: string }>().filter((m) => m.type === "hierarchy_update"),
      ).toEqual([]);
    });

    it("resolver replacement clears input and diff state installed only by an initial frame", async () => {
      const h = initialFrameHarness();
      const pane = server.simulateSubscription({ deviceSessionUuid: null });
      server.sessionResolver.bind("device-1", "session-device-1");
      await h.request(pane.subscriptionId);
      expect(server.getCurrentFrameContext("device-1")).toBe("ctx-a");
      server.setDeviceSessionResolver(server.sessionResolver);
      expect(server.getCurrentFrameContext("device-1")).toBeUndefined();
      server.pushHierarchyUpdate("device-1", h.hierarchy("after-resolver"), "ctx-new");
      expect(h.frames(pane.socket).at(-1)?.hierarchyDiff?.hasBaseline).toBe(false);
    });

    it("triggers callback, pushes hierarchy update, and acknowledges success", async () => {
      let requestedDeviceId: string | null | undefined;
      let requestSignal: AbortSignal | undefined;
      server.setOnObservationRequested(async (request) => {
        requestedDeviceId = request.deviceId;
        requestSignal = request.signal;
        return [requestedObservation("emulator-5554")];
      });
      const { socket } = server.simulateSubscription({ deviceId: "emulator-5554" });

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-1",
          command: "request_observation",
          deviceId: "emulator-5554",
        }),
      );

      expect(requestedDeviceId).toBe("emulator-5554");
      expect(requestSignal?.aborted).toBe(false);
      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
        deviceId?: string;
        data?: { packageName?: string };
      }>();
      expect(msgs).toHaveLength(2);
      expect(msgs[0].type).toBe("hierarchy_update");
      expect(msgs[0].deviceId).toBe("emulator-5554");
      expect(msgs[0].data?.packageName).toBe("com.example.app");
      expect(msgs[1].type).toBe("subscription_response");
      expect(msgs[1].id).toBe("obs-1");
      expect(msgs[1].success).toBe(true);
    });

    // The device-addressed admission gate (`DevicePool.assertDeviceActionable`,
    // reached here through the resolver) must refuse BEFORE the serial-addressed
    // observation runs. Without it the handler observed the unknown runtime,
    // `pushForDevice` then dropped every frame because routing is suspended, and
    // the requester was acknowledged with `success: true` and no hierarchy
    // ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
    it("rejects an explicit observation while the pooled identity is quarantined", async () => {
      let observed = false;
      server.setOnObservationRequested(async (request) => {
        observed = true;
        return [requestedObservation(request.deviceId ?? "emulator-5554")];
      });
      const { socket } = server.simulateSubscription({ deviceId: "emulator-5554" });
      server.sessionResolver.quarantine("emulator-5554");

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-quarantined",
          command: "request_observation",
          deviceId: "emulator-5554",
        }),
      );

      expect(observed).toBe(false);
      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
        error?: string;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].success).toBe(false);
      expect(msgs[0].id).toBe("obs-quarantined");
      expect(msgs[0].error).toContain("emulator-5554");
    });

    // An all-device request names no serial, so the gate above cannot preflight
    // it — but the same false acknowledgement follows: `pushForDevice` drops a
    // quarantined serial's hierarchy because routing is suspended, and the
    // requester was told `success: true` with nothing delivered
    // ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
    it("reports the quarantined device of an all-device observation instead of acking success", async () => {
      server.setOnObservationRequested(async () => [
        requestedObservation("emulator-5554"),
        requestedObservation("emulator-5556"),
      ]);
      const { socket } = server.simulateSubscription({ deviceId: null });
      server.sessionResolver.quarantine("emulator-5554");

      await server.processLineForTest(
        socket,
        JSON.stringify({ id: "obs-all", command: "request_observation" }),
      );

      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
        error?: string;
        deviceId?: string;
      }>();
      // The healthy device still gets its hierarchy; the quarantined one is
      // reported as a per-device failure rather than silently dropped.
      const pushed = msgs.filter((message) => message.type === "hierarchy_update");
      expect(pushed.map((message) => message.deviceId)).toEqual(["emulator-5556"]);
      const ack = msgs[msgs.length - 1];
      expect(ack.type).toBe("error");
      expect(ack.success).toBe(false);
      expect(ack.id).toBe("obs-all");
      expect(ack.error).toContain("emulator-5554");
    });

    it("forwards proven frame context and clears it when an explicit observation lacks provenance", async () => {
      server.setOnObservationRequested(async (request) => [
        requestedObservation(request.deviceId ?? "emulator-5554", "frame-A"),
      ]);
      const { socket } = server.simulateSubscription({ deviceId: "emulator-5554" });

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-context",
          command: "request_observation",
          deviceId: "emulator-5554",
        }),
      );

      const firstMessages = socket.getWrittenMessages<{
        type: string;
        frameContext?: string;
      }>();
      expect(firstMessages[0].frameContext).toBe("frame-A");
      expect(server.getCurrentFrameContext("emulator-5554")).toBe("frame-A");

      server.setOnObservationRequested(async (request) => [
        requestedObservation(request.deviceId ?? "emulator-5554"),
      ]);
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-contextless",
          command: "request_observation",
          deviceId: "emulator-5554",
        }),
      );

      expect(server.getCurrentFrameContext("emulator-5554")).toBeUndefined();
    });

    it("does not let a completed explicit observation replace a newer live frame context", async () => {
      let resolveObservation: ((observations: RequestedObservation[]) => void) | undefined;
      server.setOnObservationRequested(
        () =>
          new Promise((resolve) => {
            resolveObservation = resolve;
          }),
      );
      const { socket } = server.simulateSubscription({ deviceId: "emulator-5554" });

      const request = server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-race",
          command: "request_observation",
          deviceId: "emulator-5554",
        }),
      );
      await Promise.resolve();
      expect(resolveObservation).toBeDefined();

      server.pushHierarchyUpdate(
        "emulator-5554",
        requestedObservation("emulator-5554", "frame-B").observation.viewHierarchy!,
        "frame-B",
      );
      resolveObservation!([requestedObservation("emulator-5554", "frame-A")]);
      await request;

      expect(server.getCurrentFrameContext("emulator-5554")).toBe("frame-B");
      expect(
        socket
          .getWrittenMessages<{ type: string }>()
          .filter((message) => message.type === "hierarchy_update"),
      ).toHaveLength(1);
    });

    it("returns error when no observation callback is configured", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-2",
          command: "request_observation",
        }),
      );

      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
        error?: string;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].id).toBe("obs-2");
      expect(msgs[0].success).toBe(false);
      expect(msgs[0].error).toBe("Observation requests are not available");
    });

    it("returns error when observation has no hierarchy", async () => {
      server.setOnObservationRequested(async () => [
        {
          deviceId: "emulator-5554",
          observation: {
            updatedAt: "2026-06-24T00:00:00.000Z",
            screenSize: { width: 0, height: 0 },
            systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
            errors: [{ phase: "viewHierarchy", message: "Accessibility service unavailable" }],
            error: "Accessibility service unavailable",
          },
        },
      ]);
      const { socket } = server.simulateSubscription({ deviceId: "emulator-5554" });

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-no-hierarchy",
          command: "request_observation",
          deviceId: "emulator-5554",
        }),
      );

      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
        error?: string;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].id).toBe("obs-no-hierarchy");
      expect(msgs[0].success).toBe(false);
      expect(msgs[0].error).toBe(
        "Observation request failed for emulator-5554: Accessibility service unavailable",
      );
    });

    it("pushes healthy hierarchies and reports failures on partial all-device refresh", async () => {
      server.setOnObservationRequested(async () => [
        requestedObservation("emulator-5554"),
        {
          deviceId: "emulator-5556",
          observation: {
            updatedAt: "2026-06-24T00:00:00.000Z",
            screenSize: { width: 0, height: 0 },
            systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
            errors: [{ phase: "viewHierarchy", message: "CtrlProxy unavailable" }],
            error: "CtrlProxy unavailable",
          },
        },
      ]);
      const { socket } = server.simulateSubscription({});

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-partial",
          command: "request_observation",
        }),
      );

      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
        deviceId?: string;
        error?: string;
      }>();
      // Healthy device still receives its hierarchy_update...
      expect(msgs).toHaveLength(2);
      expect(msgs[0].type).toBe("hierarchy_update");
      expect(msgs[0].deviceId).toBe("emulator-5554");
      // ...and the failed device is surfaced in the response error.
      expect(msgs[1].type).toBe("error");
      expect(msgs[1].id).toBe("obs-partial");
      expect(msgs[1].success).toBe(false);
      expect(msgs[1].error).toBe(
        "Observation request failed for emulator-5556: CtrlProxy unavailable",
      );
    });

    it("returns error when observation callback returns no devices", async () => {
      server.setOnObservationRequested(async () => []);
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-empty",
          command: "request_observation",
        }),
      );

      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
        error?: string;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].id).toBe("obs-empty");
      expect(msgs[0].success).toBe(false);
      expect(msgs[0].error).toBe("Observation request did not capture any devices");
    });

    it("returns error when observation callback throws", async () => {
      server.setOnObservationRequested(async () => {
        throw new Error("Observe failed");
      });
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-3",
          command: "request_observation",
        }),
      );

      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
        error?: string;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].id).toBe("obs-3");
      expect(msgs[0].success).toBe(false);
      expect(msgs[0].error).toBe("Observe failed");
    });

    it("returns error and aborts request when observation times out", async () => {
      let requestSignal: AbortSignal | undefined;
      server.setOnObservationRequested((request) => {
        requestSignal = request.signal;
        return new Promise<RequestedObservation[]>(() => {});
      }, 100);
      const socket = new FakeSocket();

      const requestPromise = server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-4",
          command: "request_observation",
        }),
      );
      await Promise.resolve();
      timer.advanceTime(100);
      await requestPromise;

      expect(requestSignal?.aborted).toBe(true);
      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
        error?: string;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].id).toBe("obs-4");
      expect(msgs[0].success).toBe(false);
      expect(msgs[0].error).toBe("Observation request timed out after 100ms");
    });

    it("settles a stalled device in the batch before the outer request deadline", async () => {
      server.setOnObservationRequested(
        ({ signal }) =>
          runObservationRequestBatch(
            [{ id: "stalled" }, { id: "healthy" }],
            async (device): Promise<ObserveResult> => {
              if (device.id === "stalled") {
                return new Promise<ObserveResult>(() => undefined);
              }
              return requestedObservation(device.id).observation;
            },
            { timer, signal },
          ),
        PER_DEVICE_OBSERVATION_TIMEOUT_MS + OBSERVATION_BATCH_HEADROOM_MS,
      );
      const { socket } = server.simulateSubscription({});

      const request = server.processLineForTest(
        socket,
        JSON.stringify({ id: "obs-batch-timeout", command: "request_observation" }),
      );
      await Promise.resolve();
      await timer.advanceTimeAsync(PER_DEVICE_OBSERVATION_TIMEOUT_MS);
      await request;

      const messages = socket.getWrittenMessages<{
        id?: string;
        type: string;
        deviceId?: string;
        error?: string;
      }>();
      const observationMessages = messages.filter((message) => message.type !== "ping");
      expect(observationMessages).toHaveLength(2);
      expect(observationMessages).not.toContainEqual(
        expect.objectContaining({
          error: `Observation request timed out after ${PER_DEVICE_OBSERVATION_TIMEOUT_MS}ms`,
        }),
      );
      expect(observationMessages[0]).toMatchObject({
        type: "hierarchy_update",
        deviceId: "healthy",
      });
      expect(observationMessages[1]).toMatchObject({
        id: "obs-batch-timeout",
        type: "error",
        error: `Observation request failed for stalled: Observation request timed out after ${PER_DEVICE_OBSERVATION_TIMEOUT_MS}ms for device stalled`,
      });
    });
  });

  describe("request_navigation_graph", () => {
    const sampleGraphData: NavigationGraphStreamData = {
      appId: "com.example.app",
      nodes: [
        { id: 1, screenName: "Home", visitCount: 3 },
        { id: 2, screenName: "Settings", visitCount: 1 },
      ],
      edges: [{ id: 1, from: "Home", to: "Settings", toolName: "tapOn", traversalCount: 2 }],
      currentScreen: "Home",
    };

    it("returns navigation_update to requesting socket only when callback returns data", async () => {
      server.setOnNavigationGraphRequested(async () => sampleGraphData);

      // Subscribe two sockets
      const { socket: socket1 } = server.simulateSubscription({});
      const requestSocket = new FakeSocket();

      const requestLine = JSON.stringify({
        id: "req-1",
        command: "request_navigation_graph",
      });

      await server.processLineForTest(requestSocket, requestLine);

      // Requesting socket should receive the navigation_update
      const msgs = requestSocket.getWrittenMessages<{
        id?: string;
        type: string;
        navigationGraph?: NavigationGraphStreamData;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("navigation_update");
      expect(msgs[0].id).toBe("req-1");
      expect(msgs[0].navigationGraph?.appId).toBe("com.example.app");
      expect(msgs[0].navigationGraph?.nodes).toHaveLength(2);
      expect(msgs[0].navigationGraph?.edges).toHaveLength(1);

      // Other subscriber should NOT receive anything
      const otherMsgs = socket1.getWrittenMessages();
      expect(otherMsgs).toHaveLength(0);
    });

    it("returns success acknowledgement when no callback is set", async () => {
      const requestSocket = new FakeSocket();

      const requestLine = JSON.stringify({
        id: "req-2",
        command: "request_navigation_graph",
      });

      await server.processLineForTest(requestSocket, requestLine);

      const msgs = requestSocket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("subscription_response");
      expect(msgs[0].id).toBe("req-2");
      expect(msgs[0].success).toBe(true);
    });

    it("returns success acknowledgement when callback returns null", async () => {
      server.setOnNavigationGraphRequested(async () => null);

      const requestSocket = new FakeSocket();

      const requestLine = JSON.stringify({
        id: "req-3",
        command: "request_navigation_graph",
      });

      await server.processLineForTest(requestSocket, requestLine);

      const msgs = requestSocket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("subscription_response");
      expect(msgs[0].id).toBe("req-3");
      expect(msgs[0].success).toBe(true);
    });

    it("returns error response when callback throws", async () => {
      server.setOnNavigationGraphRequested(async () => {
        throw new Error("Graph export failed");
      });

      const requestSocket = new FakeSocket();

      const requestLine = JSON.stringify({
        id: "req-4",
        command: "request_navigation_graph",
      });

      await server.processLineForTest(requestSocket, requestLine);

      const msgs = requestSocket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
        error?: string;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].id).toBe("req-4");
      expect(msgs[0].success).toBe(false);
      expect(msgs[0].error).toBe("Graph export failed");
    });
  });

  describe("subscribe and unsubscribe", () => {
    it("handles subscribe command", async () => {
      const socket = new FakeSocket();

      const requestLine = JSON.stringify({
        id: "sub-1",
        command: "subscribe",
        deviceId: "emulator-5554",
      });

      await server.processLineForTest(socket, requestLine);

      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("subscription_response");
      expect(msgs[0].success).toBe(true);
      expect(server.getSubscriberCount()).toBe(1);
    });

    it("rejects a malformed deviceSessionUuid at the socket boundary", async () => {
      const screenshotChanges: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged((deviceId) => screenshotChanges.push(deviceId));
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-invalid-session",
          command: "subscribe",
          deviceSessionUuid: 42,
          screenshotIntervalMs: 500,
        }),
      );

      expect(socket.getWrittenMessages()).toEqual([
        {
          id: "sub-invalid-session",
          type: "error",
          success: false,
          error: "deviceSessionUuid must be a string or null",
        },
      ]);
      expect(server.getSubscriberCount()).toBe(0);
      expect(screenshotChanges).toEqual([]);
    });

    it("treats an omitted deviceSessionUuid as an intentional all-devices subscription", async () => {
      const screenshotChanges: Array<string | null> = [];
      const hierarchyChanges: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged((deviceId) => screenshotChanges.push(deviceId));
      server.setOnHierarchyCadenceChanged((deviceId) => hierarchyChanges.push(deviceId));
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-all-devices",
          command: "subscribe",
          screenshotIntervalMs: 750,
          hierarchyIntervalMs: 500,
        }),
      );

      expect(screenshotChanges).toEqual([null]);
      expect(hierarchyChanges).toEqual([null]);
      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(750);
      expect(server.getScreenshotIntervalMsForDevice("device-2")).toBe(750);
      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(500);
      expect(server.getHierarchyIntervalMsForDevice("device-2")).toBe(500);
    });

    it("rejects an unresolved deviceSessionUuid before creating a subscription", async () => {
      const screenshotChanges: Array<string | null> = [];
      const hierarchyChanges: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged((deviceId) => screenshotChanges.push(deviceId));
      server.setOnHierarchyCadenceChanged((deviceId) => hierarchyChanges.push(deviceId));
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-unknown-session",
          command: "subscribe",
          deviceSessionUuid: "session-unknown",
          screenshotIntervalMs: 250,
          hierarchyIntervalMs: 250,
        }),
      );

      expect(
        socket.getWrittenMessages<{ type: string; success?: boolean; error?: string }>(),
      ).toEqual([
        {
          id: "sub-unknown-session",
          type: "error",
          success: false,
          error: "deviceSessionUuid 'session-unknown' does not identify a live device session",
        },
      ]);
      expect(screenshotChanges).toEqual([]);
      expect(hierarchyChanges).toEqual([]);
      expect(server.getSubscriberCount()).toBe(0);
      expect(server.hasSubscriberForDevice("device-1")).toBe(false);
      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(3000);
      // No subscriber: the hierarchy cadence is paused, not the 1Hz default (#5472).
      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(2_147_483_647);
    });

    it("rejects a blank deviceSessionUuid", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-blank-session",
          command: "subscribe",
          deviceSessionUuid: "  ",
        }),
      );

      expect(socket.getWrittenMessages()).toEqual([
        {
          id: "sub-blank-session",
          type: "error",
          success: false,
          error: "deviceSessionUuid must not be blank",
        },
      ]);
      expect(server.getSubscriberCount()).toBe(0);
    });

    it("handles unsubscribe command", async () => {
      const { socket } = server.simulateSubscription({});
      expect(server.getSubscriberCount()).toBe(1);

      const requestLine = JSON.stringify({
        id: "unsub-1",
        command: "unsubscribe",
        subscriptionId: "devicedatastream-1",
      });

      await server.processLineForTest(socket, requestLine);

      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("subscription_response");
      expect(msgs[0].success).toBe(true);
      expect(server.getSubscriberCount()).toBe(0);
    });

    it("multiplexes device filters and cadence updates by subscriptionId", async () => {
      server.sessionResolver
        .bind("device-1", "session-device-1")
        .bind("device-2", "session-device-2");
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-device-1",
          command: "subscribe",
          deviceSessionUuid: "session-device-1",
          screenshotIntervalMs: 500,
        }),
      );
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-device-2",
          command: "subscribe",
          deviceSessionUuid: "session-device-2",
          screenshotIntervalMs: 1000,
        }),
      );

      const [firstResponse, secondResponse] = socket.getWrittenMessages<{
        id: string;
        subscriptionId: string;
      }>();
      expect(server.getSubscriberCount()).toBe(2);
      expect(firstResponse.subscriptionId).toBe("devicedatastream-1");
      expect(secondResponse.subscriptionId).toBe("devicedatastream-2");

      server.pushScreenshotUpdate("device-1", "device-1-frame", 100, 200);
      server.pushScreenshotUpdate("device-2", "device-2-frame", 100, 200);
      expect(
        socket
          .getWrittenMessages<{
            type: string;
            subscriptionId: string;
            screenshotBase64?: string;
          }>()
          .filter((message) => message.type === "screenshot_update"),
      ).toMatchObject([
        { subscriptionId: firstResponse.subscriptionId, screenshotBase64: "device-1-frame" },
        { subscriptionId: secondResponse.subscriptionId, screenshotBase64: "device-2-frame" },
      ]);

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "relax-device-2",
          command: "update_cadence",
          subscriptionId: secondResponse.subscriptionId,
          screenshotIntervalMs: 1500,
        }),
      );

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(500);
      expect(server.getScreenshotIntervalMsForDevice("device-2")).toBe(1500);
    });

    it("removes every multiplexed device subscription on connection close", async () => {
      const screenshotChanges: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged((deviceId) => screenshotChanges.push(deviceId));
      server.sessionResolver
        .bind("device-1", "session-device-1")
        .bind("device-2", "session-device-2");
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-device-1",
          command: "subscribe",
          deviceSessionUuid: "session-device-1",
        }),
      );
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-device-2",
          command: "subscribe",
          deviceSessionUuid: "session-device-2",
        }),
      );
      screenshotChanges.length = 0;

      server.closeConnectionForTest(socket);

      expect(server.getSubscriberCount()).toBe(0);
      // Cadence notifications carry the resolved serial (the polling key), not the uuid.
      expect(screenshotChanges).toEqual(["device-1", "device-2"]);
    });
  });

  describe("screenshot updates", () => {
    it("reuses decoded image bytes without changing the pushed message", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });
      const screenshotBase64 = pngFrame(1080, 2340);
      const decodedImage = Buffer.from(screenshotBase64, "base64");
      const fromSpy = spyOn(Buffer, "from");
      const payloadDecodes = () =>
        fromSpy.mock.calls.filter(
          ([value, encoding]) => value === screenshotBase64 && encoding === "base64",
        ).length;

      try {
        server.pushScreenshotUpdate("device-1", screenshotBase64, 1080, 2340);
        expect(payloadDecodes()).toBe(1);
        const [defaultMessage] = socket.getWrittenMessages<Record<string, unknown>>();

        socket.resetWrittenData();
        fromSpy.mockClear();
        server.pushScreenshotUpdate("device-1", screenshotBase64, 1080, 2340, {}, { decodedImage });
        expect(payloadDecodes()).toBe(0);
        const [decodedMessage] = socket.getWrittenMessages<Record<string, unknown>>();

        expect(decodedMessage).toEqual(defaultMessage);
        expect(decodedMessage).toMatchObject({
          screenshotBase64,
          screenWidth: 1080,
          screenHeight: 2340,
        });
      } finally {
        fromSpy.mockRestore();
      }
    });

    it("publishes measured JPEG/WebP dimensions and omits unknown geometry claims", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });
      const jpegBase64 = encodedFrames.jpeg.toString("base64");
      const webpBase64 = encodedFrames.webp.toString("base64");

      server.pushScreenshotUpdate(
        "device-1",
        jpegBase64,
        1080,
        2340,
        {},
        {
          decodedImage: encodedFrames.jpeg,
          captureSequence: 8,
        },
      );
      server.pushScreenshotUpdate(
        "device-1",
        webpBase64,
        1080,
        2340,
        {},
        {
          decodedImage: encodedFrames.webp,
          captureSequence: 9,
        },
      );
      const garbage = Buffer.from("not an image");
      server.pushScreenshotUpdate(
        "device-1",
        garbage.toString("base64"),
        undefined,
        undefined,
        {},
        {
          decodedImage: garbage,
          captureSequence: 10,
        },
      );

      const [jpegMessage, webpMessage, garbageMessage] =
        socket.getWrittenMessages<Record<string, unknown>>();
      expect(jpegMessage).toMatchObject({ screenWidth: 37, screenHeight: 53 });
      expect(jpegMessage).not.toHaveProperty("captureSequence");
      expect(webpMessage).toMatchObject({ screenWidth: 37, screenHeight: 53 });
      expect(webpMessage).not.toHaveProperty("captureSequence");
      expect(garbageMessage).not.toHaveProperty("screenWidth");
      expect(garbageMessage).not.toHaveProperty("screenHeight");
      expect(garbageMessage).not.toHaveProperty("captureSequence");
    });

    it("includes optional screenshot metadata when pushing updates", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      server.pushScreenshotUpdate("device-1", "png-frame", 1080, 2340, {
        screenshotMimeType: "image/png",
        screenshotFormat: "png",
        screenshotCaptureSource: "android_adb_screencap",
        screenshotFallback: true,
        screenshotFallbackReason: "websocket_unavailable",
        screenshotCaptureDurationMs: 42,
        screenshotEncodeDurationMs: 7,
        screenshotByteLength: 1200,
        screenshotBase64Length: 1600,
        checksum: "internal-checksum",
      } as any);

      const msgs = socket.getWrittenMessages<{
        type: string;
        deviceId?: string;
        screenshotBase64?: string;
        screenWidth?: number;
        screenHeight?: number;
        screenshotMimeType?: string;
        screenshotFormat?: string;
        screenshotCaptureSource?: string;
        screenshotFallback?: boolean;
        screenshotFallbackReason?: string;
        screenshotCaptureDurationMs?: number;
        screenshotEncodeDurationMs?: number;
        screenshotByteLength?: number;
        screenshotBase64Length?: number;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({
        type: "screenshot_update",
        deviceId: "device-1",
        screenshotBase64: "png-frame",
        screenWidth: 1080,
        screenHeight: 2340,
        screenshotMimeType: "image/png",
        screenshotFormat: "png",
        screenshotCaptureSource: "android_adb_screencap",
        screenshotFallback: true,
        screenshotFallbackReason: "websocket_unavailable",
        screenshotCaptureDurationMs: 42,
        screenshotEncodeDurationMs: 7,
        screenshotByteLength: 1200,
        screenshotBase64Length: 1600,
      });
      expect(msgs[0]).not.toHaveProperty("checksum");
    });

    it("omits screenshot performance metadata when it is not provided", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      server.pushScreenshotUpdate("device-1", "legacy-frame", 1080, 2340, {
        screenshotMimeType: "image/jpeg",
        screenshotFormat: "jpeg",
        screenshotCaptureSource: "android_ctrlproxy_a11y",
        screenshotFallback: false,
      });

      const [message] = socket.getWrittenMessages<Record<string, unknown>>();
      expect(message).toMatchObject({
        type: "screenshot_update",
        screenshotBase64: "legacy-frame",
        screenshotMimeType: "image/jpeg",
      });
      expect(message).not.toHaveProperty("screenshotCaptureDurationMs");
      expect(message).not.toHaveProperty("screenshotEncodeDurationMs");
      expect(message).not.toHaveProperty("screenshotByteLength");
      expect(message).not.toHaveProperty("screenshotBase64Length");
    });
  });

  /** A minimal PNG whose IHDR declares the given pixel size, base64-encoded as CtrlProxy sends it. */
  const pngFrame = (width: number, height: number): string => {
    const buffer = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
    buffer.writeUInt32BE(13, 8); // IHDR data length, fixed by the PNG spec
    buffer.write("IHDR", 12, "ascii");
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer.toString("base64");
  };

  describe("hierarchy diff annotation", () => {
    const frame = (text: string, rotation: number = 0) =>
      ({
        hierarchy: { node: { $: { class: "Root" }, node: [{ $: { class: "Child", text } }] } },
        rotation,
      }) as any;

    it("reports no baseline and annotates nothing on the first frame", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      server.pushHierarchyUpdate("device-1", frame("a"));

      const [message] = socket.getWrittenMessages<any>();
      expect(message.type).toBe("hierarchy_update");
      expect(message.hierarchyDiff).toEqual({
        hasBaseline: false,
        added: 0,
        changed: 0,
        removed: 0,
      });
      expect(message.data.hierarchy.node.node[0].$.diffState).toBeUndefined();
    });

    it("annotates changed nodes and summarizes the diff against the previous frame", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      server.pushHierarchyUpdate("device-1", frame("a"));
      server.pushHierarchyUpdate("device-1", frame("b"));

      const messages = socket.getWrittenMessages<any>();
      expect(messages).toHaveLength(2);
      expect(messages[1].hierarchyDiff).toEqual({
        hasBaseline: true,
        added: 0,
        changed: 1,
        removed: 0,
      });
      expect(messages[1].data.hierarchy.node.node[0].$.diffState).toBe("changed");
    });

    it("resets the diff baseline when the device connection is lost", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      server.pushHierarchyUpdate("device-1", frame("a"));
      server.onDeviceConnectionLost("device-1");
      server.pushHierarchyUpdate("device-1", frame("b"));

      // The post-reconnect frame is diffed against a fresh baseline, not the
      // pre-drop tree, so it reports no baseline rather than a spurious change.
      const messages = socket.getWrittenMessages<any>();
      const hierarchyMessages = messages.filter((m) => m.type === "hierarchy_update");
      expect(hierarchyMessages[hierarchyMessages.length - 1].hierarchyDiff.hasBaseline).toBe(false);
    });

    it("forgets a device frame context when the connection is lost", () => {
      server.pushHierarchyUpdate("device-1", frame("a"), "frame-A");
      server.onDeviceConnectionLost("device-1");

      expect(server.getCurrentFrameContext("device-1")).toBeUndefined();
    });

    it("stamps a monotonic capture identity on each hierarchy and echoes it on matching screenshots", () => {
      // Issue #3348: a control client pairs a screenshot with the hierarchy its geometry came from
      // by requiring equal captureSequence. The echo happens only when the frame's REAL pixels
      // match the geometry the capture client claimed for it.
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      const first = server.pushHierarchyUpdate("device-1", frame("a", 0));
      server.pushScreenshotUpdate(
        "device-1",
        pngFrame(1080, 2340),
        1080,
        2340,
        {},
        {
          captureSequence: first ?? undefined,
          rotation: 0,
        },
      );
      const second = server.pushHierarchyUpdate("device-1", frame("b", 1));
      server.pushScreenshotUpdate(
        "device-1",
        pngFrame(720, 1560),
        720,
        1560,
        {},
        {
          captureSequence: second ?? undefined,
          rotation: 1,
        },
      );

      const [h1, s1, h2, s2] = socket
        .getWrittenMessages<any>()
        .filter((m) => m.type === "hierarchy_update" || m.type === "screenshot_update");

      expect(h1.captureSequence).toBe(1);
      expect(s1.captureSequence).toBe(1);
      expect(h2.captureSequence).toBe(2);
      expect(s2.captureSequence).toBe(2);
      expect(h1.rotation).toBe(0);
      expect(s1.rotation).toBe(0);
      expect(h2.rotation).toBe(1);
      expect(s2.rotation).toBe(1);
    });

    it("omits the capture identity when fresh pixels outran the hierarchy that claimed the geometry", () => {
      // THE defect this pairing exists for. The device drops to 720x1560. The next screenshot
      // carries the new pixels, but the capture client's screen-dimension cache is still the
      // previous hierarchy's 1080x2340 — so it CLAIMS 1080x2340 for a 720x1560 frame. Stamping the
      // outstanding capture id here would let a client pair those pixels with the stale hierarchy
      // and map a tap through the wrong absolute bounds. The two resolutions share an aspect ratio
      // exactly, so nothing downstream could detect it.
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      const captureSequence = server.pushHierarchyUpdate("device-1", frame("a"));
      server.pushScreenshotUpdate(
        "device-1",
        pngFrame(720, 1560),
        1080,
        2340,
        {},
        {
          captureSequence: captureSequence ?? undefined,
        },
      );

      const screenshot = socket
        .getWrittenMessages<any>()
        .find((m) => m.type === "screenshot_update");
      expect(screenshot.captureSequence).toBeUndefined();
      // The published geometry is the frame's real size, not the stale claim, so a client that
      // falls back to it maps through the pixels it is actually rendering.
      expect(screenshot.screenWidth).toBe(720);
      expect(screenshot.screenHeight).toBe(1560);
    });

    it("omits the capture identity for callers whose geometry has no tracked capture", () => {
      // TakeScreenshot reads dimensions out of the PNG it just captured; they match the pixels by
      // construction but have no relationship to any hierarchy, so they must never be paired.
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      server.pushHierarchyUpdate("device-1", frame("a"));
      server.pushScreenshotUpdate("device-1", pngFrame(1080, 2340), 1080, 2340);

      const screenshot = socket
        .getWrittenMessages<any>()
        .find((m) => m.type === "screenshot_update");
      expect(screenshot.captureSequence).toBeUndefined();
    });

    it("accepts a landscape claim against a native-portrait frame (orientation swap)", () => {
      // iOS landscape: hierarchy geometry is display-oriented (2532x1170) while the screenshot
      // arrives in native portrait pixel orientation (1170x2532) - the rotation the renderer
      // already corrects for. Rejecting this would strip the identity from every landscape frame
      // and make device control impossible in that orientation.
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      const captureSequence = server.pushHierarchyUpdate("device-1", frame("a"));
      server.pushScreenshotUpdate(
        "device-1",
        pngFrame(1170, 2532),
        2532,
        1170,
        {},
        {
          captureSequence: captureSequence ?? undefined,
        },
      );

      const screenshot = socket
        .getWrittenMessages<any>()
        .find((m) => m.type === "screenshot_update");
      expect(screenshot.captureSequence).toBe(captureSequence);
      // The MEASURED dimensions are still what gets published, so a client maps through the pixels
      // it actually renders rather than the claim.
      expect(screenshot.screenWidth).toBe(1170);
      expect(screenshot.screenHeight).toBe(2532);
    });

    it("still rejects a scale change that happens to preserve aspect", () => {
      // The swap accepts exactly ONE alternative. A uniform scale is not it.
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      const captureSequence = server.pushHierarchyUpdate("device-1", frame("a"));
      server.pushScreenshotUpdate(
        "device-1",
        pngFrame(720, 1560),
        1080,
        2340,
        {},
        {
          captureSequence: captureSequence ?? undefined,
        },
      );

      const screenshot = socket
        .getWrittenMessages<any>()
        .find((m) => m.type === "screenshot_update");
      expect(screenshot.captureSequence).toBeUndefined();
    });

    it("still rejects dimensions unrelated to the claim", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      const captureSequence = server.pushHierarchyUpdate("device-1", frame("a"));
      server.pushScreenshotUpdate(
        "device-1",
        pngFrame(800, 600),
        1080,
        2340,
        {},
        {
          captureSequence: captureSequence ?? undefined,
        },
      );

      const screenshot = socket
        .getWrittenMessages<any>()
        .find((m) => m.type === "screenshot_update");
      expect(screenshot.captureSequence).toBeUndefined();
    });

    it("omits the capture identity for a frame with a malformed header", () => {
      // A PNG signature with a bad IHDR chunk must read as unmeasurable, not as whatever bytes sit
      // at the width offset — otherwise the "measure, don't trust the claim" guarantee is silently
      // defeated and a bogus measurement could match the claim and get stamped.
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });
      const malformed = Buffer.from(pngFrame(1080, 2340), "base64");
      malformed.write("IDAT", 12, "ascii");

      const captureSequence = server.pushHierarchyUpdate("device-1", frame("a"));
      server.pushScreenshotUpdate(
        "device-1",
        malformed.toString("base64"),
        1080,
        2340,
        {},
        {
          captureSequence: captureSequence ?? undefined,
        },
      );

      const screenshot = socket
        .getWrittenMessages<any>()
        .find((m) => m.type === "screenshot_update");
      expect(screenshot.captureSequence).toBeUndefined();
    });

    it("omits the capture identity for a frame whose dimensions cannot be measured", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      const captureSequence = server.pushHierarchyUpdate("device-1", frame("a"));
      server.pushScreenshotUpdate(
        "device-1",
        Buffer.from("not-an-image").toString("base64"),
        1080,
        2340,
        {},
        {
          captureSequence: captureSequence ?? undefined,
        },
      );

      const screenshot = socket
        .getWrittenMessages<any>()
        .find((m) => m.type === "screenshot_update");
      expect(screenshot.captureSequence).toBeUndefined();
      // Unmeasurable: fall back to the caller's claim for display, but never pair on it.
      expect(screenshot.screenWidth).toBe(1080);
    });

    it("omits the capture identity until a hierarchy has been pushed", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      server.pushScreenshotUpdate("device-1", pngFrame(1080, 2340), 1080, 2340);

      const screenshot = socket
        .getWrittenMessages<any>()
        .find((m) => m.type === "screenshot_update");
      expect(screenshot.captureSequence).toBeUndefined();
    });

    it("keeps a screenshot bound to the capture it was REQUESTED under, not the newest one", () => {
      // Same-resolution navigation, the case no measurement can catch. A frame is requested while
      // screen A's hierarchy is current; screen B's hierarchy — identical dimensions — is forwarded
      // before the frame is pushed. Reading "the newest capture" at push time would label A's
      // pixels with B's identity and let a control client tap stale content.
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      const screenA = server.pushHierarchyUpdate("device-1", frame("screen-a"));
      // ... screenshot request goes out here, bound to screenA ...
      const screenB = server.pushHierarchyUpdate("device-1", frame("screen-b"));
      expect(screenB).toBeGreaterThan(screenA!);
      // ... and only now does the in-flight frame arrive and get pushed.
      server.pushScreenshotUpdate(
        "device-1",
        pngFrame(1080, 2340),
        1080,
        2340,
        {},
        {
          captureSequence: screenA ?? undefined,
        },
      );

      const screenshot = socket
        .getWrittenMessages<any>()
        .find((m) => m.type === "screenshot_update");
      expect(screenshot.captureSequence).toBe(screenA);
      expect(screenshot.captureSequence).not.toBe(screenB);
    });

    it("never reuses a capture identity after a reconnect", () => {
      // Resetting the counter to 1 on connection loss would COLLIDE with a pre-drop hierarchy a
      // client may still hold, letting a post-reconnect screenshot pair with stale geometry.
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      server.pushHierarchyUpdate("device-1", frame("a"));
      server.pushHierarchyUpdate("device-1", frame("b"));
      server.onDeviceConnectionLost("device-1");
      server.pushHierarchyUpdate("device-1", frame("c"));

      const ids = socket
        .getWrittenMessages<any>()
        .filter((m) => m.type === "hierarchy_update")
        .map((m) => m.captureSequence);

      expect(new Set(ids).size).toBe(ids.length);
      expect(ids[2]).toBeGreaterThan(ids[1]);
    });

    it("drops the device's current capture so a pre-reconnect screenshot cannot pair", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      server.pushHierarchyUpdate("device-1", frame("a"));
      server.onDeviceConnectionLost("device-1");
      // The client drops its binding when the connection goes away, so nothing is supplied.
      server.pushScreenshotUpdate("device-1", pngFrame(1080, 2340), 1080, 2340);

      const screenshot = socket
        .getWrittenMessages<any>()
        .find((m) => m.type === "screenshot_update");
      expect(screenshot.captureSequence).toBeUndefined();
    });

    it("does not mutate the caller's hierarchy when annotating", () => {
      server.simulateSubscription({ deviceId: "device-1" });

      server.pushHierarchyUpdate("device-1", frame("a"));
      const second = frame("b");
      server.pushHierarchyUpdate("device-1", second);

      expect(second.hierarchy.node.node[0].$.diffState).toBeUndefined();
    });
  });

  describe("hasSubscriberForDevice", () => {
    it("returns false when there are no subscribers", () => {
      expect(server.hasSubscriberForDevice("device-1")).toBe(false);
    });

    it("returns true for all-device subscribers", () => {
      server.simulateSubscription({});

      expect(server.hasSubscriberForDevice("device-1")).toBe(true);
    });

    it("returns true for subscribers targeting the same device", () => {
      server.simulateSubscription({ deviceId: "device-1" });

      expect(server.hasSubscriberForDevice("device-1")).toBe(true);
    });

    it("returns false when subscribers target a different device", () => {
      server.simulateSubscription({ deviceId: "device-2" });

      expect(server.hasSubscriberForDevice("device-1")).toBe(false);
    });

    it("ignores destroyed subscriber sockets", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });
      socket.destroy();

      expect(server.hasSubscriberForDevice("device-1")).toBe(false);
    });
  });

  describe("screenshot cadence aggregation", () => {
    it("uses the default screenshot keepalive cadence when subscribers omit cadence", () => {
      server.simulateSubscription({ deviceId: "device-1" });

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(3000);
    });

    it("parses requested screenshot cadence from subscribe commands", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-fast",
          command: "subscribe",
          deviceId: "device-1",
          screenshotIntervalMs: 500,
        }),
      );

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(500);
    });

    it("clamps requested screenshot cadence to the safe minimum", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-clamped",
          command: "subscribe",
          deviceId: "device-1",
          screenshotIntervalMs: 50,
        }),
      );

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(250);
    });

    it("clamps requested screenshot cadence to the maximum timer delay", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-max-clamped",
          command: "subscribe",
          deviceId: "device-1",
          screenshotIntervalMs: 3_000_000_000,
        }),
      );

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(2_147_483_647);
    });

    it("uses the fastest active requested cadence for a device", () => {
      server.simulateSubscription({ deviceId: "device-1", screenshotIntervalMs: 1000 });
      server.simulateSubscription({ deviceId: "device-1", screenshotIntervalMs: 500 });
      server.simulateSubscription({ deviceId: "device-2", screenshotIntervalMs: 250 });

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(500);
    });

    it("keeps default cadence when another subscriber requests a slower cadence", () => {
      server.simulateSubscription({ deviceId: "device-1" });
      server.simulateSubscription({ deviceId: "device-1", screenshotIntervalMs: 10_000 });

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(3000);
    });

    it("applies all-device subscriber cadence to each device", () => {
      server.simulateSubscription({ screenshotIntervalMs: 750 });

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(750);
      expect(server.getScreenshotIntervalMsForDevice("device-2")).toBe(750);
    });

    it("removes requested cadence after unsubscribe", async () => {
      const { socket } = server.simulateSubscription({
        deviceId: "device-1",
        screenshotIntervalMs: 500,
      });

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "unsub-fast",
          command: "unsubscribe",
          subscriptionId: "devicedatastream-1",
        }),
      );

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(3000);
    });

    it("ignores destroyed subscriber sockets when aggregating cadence", () => {
      const { socket } = server.simulateSubscription({
        deviceId: "device-1",
        screenshotIntervalMs: 500,
      });
      socket.destroy();

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(3000);
    });

    it("notifies when subscribe changes screenshot cadence", async () => {
      const changedDevices: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged((deviceId) => {
        changedDevices.push(deviceId);
      });
      server.sessionResolver.bind("device-1", "session-device-1");
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-fast",
          command: "subscribe",
          deviceSessionUuid: "session-device-1",
          screenshotIntervalMs: 500,
        }),
      );

      // Cadence notifications carry the resolved serial, not the uuid.
      expect(changedDevices).toEqual(["device-1"]);
    });

    it("notifies when unsubscribe removes screenshot cadence", async () => {
      const changedDevices: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged((deviceId) => {
        changedDevices.push(deviceId);
      });
      const { socket } = server.simulateSubscription({
        deviceId: "device-1",
        screenshotIntervalMs: 500,
      });

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "unsub-fast",
          command: "unsubscribe",
          subscriptionId: "devicedatastream-1",
        }),
      );

      expect(changedDevices).toEqual(["device-1"]);
    });

    it("does not notify when unsubscribe has no active subscription", async () => {
      const changedDevices: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged((deviceId) => {
        changedDevices.push(deviceId);
      });
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "unsub-missing",
          command: "unsubscribe",
          subscriptionId: "devicedatastream-missing",
        }),
      );

      expect(changedDevices).toEqual([]);
    });

    it("notifies when connection close removes screenshot cadence", () => {
      const changedDevices: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged((deviceId) => {
        changedDevices.push(deviceId);
      });
      const { socket } = server.simulateSubscription({
        deviceId: "device-1",
        screenshotIntervalMs: 500,
      });

      server.closeConnectionForTest(socket);

      expect(changedDevices).toEqual(["device-1"]);
    });
  });

  describe("hierarchy cadence aggregation", () => {
    it("uses the default hierarchy polling cadence when subscribers omit cadence", () => {
      server.simulateSubscription({ deviceId: "device-1" });

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(1000);
    });

    it("uses a caller-provided hierarchy fallback when subscribers omit cadence", () => {
      server.simulateSubscription({ deviceId: "device-1" });

      expect(server.getHierarchyIntervalMsForDevice("device-1", 250)).toBe(250);
    });

    it("pauses hierarchy cadence when no subscriber wants the device (#5472)", () => {
      // No subscription at all: do NOT instruct the runner to poll at 1Hz.
      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(2_147_483_647);
      // A caller-provided fallback is still overridden by the no-subscriber pause.
      expect(server.getHierarchyIntervalMsForDevice("device-1", 250)).toBe(2_147_483_647);
    });

    it("restores fast hierarchy cadence once a subscriber appears (#5472)", () => {
      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(2_147_483_647);

      server.simulateSubscription({ deviceId: "device-1", hierarchyIntervalMs: 500 });

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(500);
    });

    it("pauses only devices with no subscriber, leaving subscribed peers fast (#5472)", () => {
      server.simulateSubscription({ deviceId: "device-1", hierarchyIntervalMs: 500 });

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(500);
      expect(server.getHierarchyIntervalMsForDevice("device-2")).toBe(2_147_483_647);
    });

    it("parses requested hierarchy cadence from subscribe commands", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-fast-hierarchy",
          command: "subscribe",
          deviceId: "device-1",
          hierarchyIntervalMs: 500,
        }),
      );

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(500);
    });

    it("clamps requested hierarchy cadence to the safe minimum", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-clamped-hierarchy",
          command: "subscribe",
          deviceId: "device-1",
          hierarchyIntervalMs: 50,
        }),
      );

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(250);
    });

    it("clamps requested hierarchy cadence to the maximum timer delay", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-hierarchy-max-clamped",
          command: "subscribe",
          deviceId: "device-1",
          hierarchyIntervalMs: 3_000_000_000,
        }),
      );

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(2_147_483_647);
    });

    it("uses the fastest active requested hierarchy cadence for a device", () => {
      server.simulateSubscription({ deviceId: "device-1", hierarchyIntervalMs: 1000 });
      server.simulateSubscription({ deviceId: "device-1", hierarchyIntervalMs: 500 });
      server.simulateSubscription({ deviceId: "device-2", hierarchyIntervalMs: 250 });

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(500);
    });

    it("applies all-device subscriber hierarchy cadence to each device", () => {
      server.simulateSubscription({ hierarchyIntervalMs: 750 });

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(750);
      expect(server.getHierarchyIntervalMsForDevice("device-2")).toBe(750);
    });

    it("uses the slowest explicit hierarchy cadence when omitted subscribers do not request one", () => {
      server.simulateSubscription({ deviceId: "device-1" });
      server.simulateSubscription({ deviceId: "device-1", hierarchyIntervalMs: 10_000 });

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(10_000);
    });

    it("ignores subscribers that omit hierarchy cadence when another subscriber requests one", () => {
      server.simulateSubscription({ deviceId: "device-1" });
      server.simulateSubscription({ deviceId: "device-1", hierarchyIntervalMs: 500 });

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(500);
    });

    it("pauses hierarchy cadence after unsubscribe leaves no subscriber", async () => {
      const { socket } = server.simulateSubscription({
        deviceId: "device-1",
        hierarchyIntervalMs: 500,
      });

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "unsub-fast-hierarchy",
          command: "unsubscribe",
          subscriptionId: "devicedatastream-1",
        }),
      );

      // No subscriber remains: pause runner polling rather than fall back to 1Hz (#5472).
      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(2_147_483_647);
    });

    it("ignores destroyed subscriber sockets when aggregating hierarchy cadence", () => {
      const { socket } = server.simulateSubscription({
        deviceId: "device-1",
        hierarchyIntervalMs: 500,
      });
      socket.destroy();

      // A destroyed socket is not an active subscriber, so cadence is paused (#5472).
      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(2_147_483_647);
    });

    it("notifies when subscribe changes hierarchy cadence", async () => {
      const changedDevices: Array<string | null> = [];
      server.setOnHierarchyCadenceChanged((deviceId: string | null) => {
        changedDevices.push(deviceId);
      });
      server.sessionResolver.bind("device-1", "session-device-1");
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-fast-hierarchy",
          command: "subscribe",
          deviceSessionUuid: "session-device-1",
          hierarchyIntervalMs: 500,
        }),
      );

      // Cadence notifications carry the resolved serial, not the uuid.
      expect(changedDevices).toEqual(["device-1"]);
    });

    it("notifies when unsubscribe removes hierarchy cadence", async () => {
      const changedDevices: Array<string | null> = [];
      server.setOnHierarchyCadenceChanged((deviceId: string | null) => {
        changedDevices.push(deviceId);
      });
      const { socket } = server.simulateSubscription({
        deviceId: "device-1",
        hierarchyIntervalMs: 500,
      });

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "unsub-hierarchy-fast",
          command: "unsubscribe",
          subscriptionId: "devicedatastream-1",
        }),
      );

      expect(changedDevices).toEqual(["device-1"]);
    });

    it("notifies when connection close removes hierarchy cadence", () => {
      const changedDevices: Array<string | null> = [];
      server.setOnHierarchyCadenceChanged((deviceId: string | null) => {
        changedDevices.push(deviceId);
      });
      const { socket } = server.simulateSubscription({
        deviceId: "device-1",
        hierarchyIntervalMs: 500,
      });

      server.closeConnectionForTest(socket);

      expect(changedDevices).toEqual(["device-1"]);
    });
  });

  describe("update_cadence", () => {
    it("raises the screenshot cadence for an existing subscription in place", async () => {
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub",
          command: "subscribe",
          deviceId: "device-1",
        }),
      );
      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(3000);

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "upd",
          command: "update_cadence",
          subscriptionId: "devicedatastream-1",
          deviceId: "device-1",
          screenshotIntervalMs: 500,
        }),
      );

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(500);
    });

    it("does not add a second subscriber when updating cadence", async () => {
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub",
          command: "subscribe",
          deviceId: "device-1",
        }),
      );

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "upd",
          command: "update_cadence",
          subscriptionId: "devicedatastream-1",
          deviceId: "device-1",
          screenshotIntervalMs: 500,
        }),
      );

      expect((server as any).subscribers.size).toBe(1);
    });

    it("relaxes cadence back to the default when the field is omitted", async () => {
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub",
          command: "subscribe",
          deviceId: "device-1",
          screenshotIntervalMs: 500,
        }),
      );
      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(500);

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "upd",
          command: "update_cadence",
          subscriptionId: "devicedatastream-1",
          deviceId: "device-1",
        }),
      );

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(3000);
    });

    it("clamps the updated hierarchy cadence and notifies both cadence listeners", async () => {
      const changedScreenshot: Array<string | null> = [];
      const changedHierarchy: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged((deviceId) => changedScreenshot.push(deviceId));
      server.setOnHierarchyCadenceChanged((deviceId) => changedHierarchy.push(deviceId));
      server.sessionResolver.bind("device-1", "session-device-1");
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub",
          command: "subscribe",
          deviceSessionUuid: "session-device-1",
        }),
      );
      changedScreenshot.length = 0;
      changedHierarchy.length = 0;

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "upd",
          command: "update_cadence",
          subscriptionId: "devicedatastream-1",
          hierarchyIntervalMs: 50,
        }),
      );

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(250);
      // Cadence notifications carry the resolved serial, not the uuid.
      expect(changedScreenshot).toEqual(["device-1"]);
      expect(changedHierarchy).toEqual(["device-1"]);
    });

    it("acknowledges update_cadence with a subscription_response", async () => {
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub",
          command: "subscribe",
          deviceId: "device-1",
        }),
      );

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "upd-ack",
          command: "update_cadence",
          subscriptionId: "devicedatastream-1",
          deviceId: "device-1",
          screenshotIntervalMs: 500,
        }),
      );

      const ack = socket
        .getWrittenMessages<{ id?: string; type: string; success?: boolean }>()
        .find((message) => message.id === "upd-ack");
      expect(ack?.type).toBe("subscription_response");
      expect(ack?.success).toBe(true);
    });

    it("rejects update_cadence when the socket has no active subscription", async () => {
      const changedScreenshot: Array<string | null> = [];
      const changedHierarchy: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged((deviceId) => changedScreenshot.push(deviceId));
      server.setOnHierarchyCadenceChanged((deviceId) => changedHierarchy.push(deviceId));
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "upd-no-sub",
          command: "update_cadence",
          subscriptionId: "devicedatastream-missing",
          deviceId: "device-1",
          screenshotIntervalMs: 500,
        }),
      );

      const response = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
        error?: string;
      }>();
      expect(response).toHaveLength(1);
      expect(response[0]).toMatchObject({
        id: "upd-no-sub",
        type: "error",
        success: false,
      });
      expect(response[0].error).toContain("devicedatastream-missing");
      expect(response[0].error).toContain("resubscribe");
      expect(server.getSubscriberCount()).toBe(0);
      expect(changedScreenshot).toEqual([]);
      expect(changedHierarchy).toEqual([]);
    });

    it("rejects update_cadence after its subscription has been unsubscribed", async () => {
      const changedScreenshot: Array<string | null> = [];
      const changedHierarchy: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged((deviceId) => changedScreenshot.push(deviceId));
      server.setOnHierarchyCadenceChanged((deviceId) => changedHierarchy.push(deviceId));
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({ id: "sub", command: "subscribe", deviceId: "device-1" }),
      );
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "unsub",
          command: "unsubscribe",
          subscriptionId: "devicedatastream-1",
        }),
      );
      changedScreenshot.length = 0;
      changedHierarchy.length = 0;

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "upd-reaped",
          command: "update_cadence",
          subscriptionId: "devicedatastream-1",
          screenshotIntervalMs: 500,
        }),
      );

      expect(
        socket.getWrittenMessages<{
          id?: string;
          type: string;
          success?: boolean;
          error?: string;
        }>(),
      ).toContainEqual({
        id: "upd-reaped",
        type: "error",
        success: false,
        error:
          "subscriptionId 'devicedatastream-1' is not active; resubscribe before updating cadence",
      });
      expect(server.getSubscriberCount()).toBe(0);
      expect(changedScreenshot).toEqual([]);
      expect(changedHierarchy).toEqual([]);
    });

    it("rejects update_cadence when subscriptionId is omitted", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({ id: "upd-no-id", command: "update_cadence", screenshotIntervalMs: 500 }),
      );

      expect(
        socket.getWrittenMessages<{
          id?: string;
          type: string;
          success?: boolean;
          error?: string;
        }>(),
      ).toEqual([
        {
          id: "upd-no-id",
          type: "error",
          success: false,
          error: "subscriptionId is required; resubscribe before updating cadence",
        },
      ]);
      expect(server.getSubscriberCount()).toBe(0);
    });
  });

  describe("onDeviceConnectionLost", () => {
    it("pushes a device-scoped error to subscribers for that device", () => {
      const { socket } = server.simulateSubscription({ deviceId: "emulator-5554" });
      timer.advanceTime(1234);

      server.onDeviceConnectionLost("emulator-5554");

      const msgs = socket.getWrittenMessages<{
        type: string;
        success?: boolean;
        deviceId?: string;
        deviceSessionUuid?: string | null;
        timestamp?: number;
        error?: string;
      }>();
      expect(msgs).toEqual([
        {
          type: "error",
          success: false,
          subscriptionId: "devicedatastream-1",
          deviceId: "emulator-5554",
          // Resolved from the serial by the harness's auto-bound resolver (epic #5256).
          deviceSessionUuid: "session-emulator-5554",
          timestamp: 1234,
          error: "device connection lost",
        },
      ]);
    });

    it("pushes device connection errors to all-device subscribers", () => {
      const { socket } = server.simulateSubscription({});

      server.onDeviceConnectionLost("emulator-5554");

      const msgs = socket.getWrittenMessages<{ type: string; deviceId?: string; error?: string }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({
        type: "error",
        deviceId: "emulator-5554",
        error: "device connection lost",
      });
    });

    it("does not push device connection errors to other device subscribers", () => {
      const { socket } = server.simulateSubscription({ deviceId: "emulator-5556" });

      server.onDeviceConnectionLost("emulator-5554");

      expect(socket.getWrittenMessages()).toHaveLength(0);
    });
  });

  describe("canonical-pixel conversion at the wire (issue #4549)", () => {
    // A hierarchy carrying the #4548 runner scale metadata: iOS points + nativeScale + reported
    // physical pixel dims. Element bounds live under $.bounds as {left,top,right,bottom}.
    const iosFrame = () =>
      ({
        hierarchy: {
          bounds: { left: 0, top: 0, right: 390, bottom: 844 },
          node: {
            $: { class: "UIWindow", bounds: { left: 0, top: 0, right: 390, bottom: 844 } },
            node: [
              {
                $: {
                  class: "UIButton",
                  text: "Go",
                  bounds: { left: 10, top: 20, right: 100, bottom: 60 },
                },
              },
            ],
          },
        },
        screenWidth: 390,
        screenHeight: 844,
        screenScale: 3,
        nativeScale: 3,
        pixelWidth: 1170,
        pixelHeight: 2532,
      }) as any;

    it("publishes iOS element bounds and screen dims in pixels and stamps coordinateSpace:px", () => {
      const { socket } = server.simulateSubscription({ deviceId: "ios-1" });
      server.pushHierarchyUpdate("ios-1", iosFrame());

      const [message] = socket.getWrittenMessages<any>();
      expect(message.type).toBe("hierarchy_update");
      expect(message.coordinateSpace).toBe("px");
      expect(message.nativeScale).toBe(3);
      expect(message.data.screenWidth).toBe(1170);
      expect(message.data.screenHeight).toBe(2532);
      expect(message.data.hierarchy.node.$.bounds).toEqual({
        left: 0,
        top: 0,
        right: 1170,
        bottom: 2532,
      });
      expect(message.data.hierarchy.node.node[0].$.bounds).toEqual({
        left: 30,
        top: 60,
        right: 300,
        bottom: 180,
      });
      expect(message.data.hierarchy.bounds).toEqual({ left: 0, top: 0, right: 1170, bottom: 2532 });
    });

    it("does not mutate the caller's hierarchy (MCP observe keeps point-space bounds)", () => {
      server.simulateSubscription({ deviceId: "ios-1" });
      const input = iosFrame();
      server.pushHierarchyUpdate("ios-1", input);
      // The push converts a clone; the object the caller (and MCP observe) holds is untouched.
      expect(input.data ?? input.hierarchy.node.$.bounds).toEqual({
        left: 0,
        top: 0,
        right: 390,
        bottom: 844,
      });
      expect(input.screenWidth).toBe(390);
    });

    it("LEGACY: a hierarchy without runner metadata is byte-identical (points, no px stamp)", () => {
      const { socket } = server.simulateSubscription({ deviceId: "ios-legacy" });
      const legacy = iosFrame();
      delete legacy.nativeScale;
      delete legacy.pixelWidth;
      delete legacy.pixelHeight;
      server.pushHierarchyUpdate("ios-legacy", legacy);

      const [message] = socket.getWrittenMessages<any>();
      expect(message.coordinateSpace).toBeUndefined();
      expect(message.nativeScale).toBeUndefined();
      // Point-space bounds and dims pass through unchanged.
      expect(message.data.screenWidth).toBe(390);
      expect(message.data.hierarchy.node.node[0].$.bounds).toEqual({
        left: 10,
        top: 20,
        right: 100,
        bottom: 60,
      });
    });

    it("Android (nativeScale 1) leaves bounds numerically identical but still declares px", () => {
      const { socket } = server.simulateSubscription({ deviceId: "android-1" });
      const androidFrame = {
        hierarchy: {
          node: {
            $: { class: "FrameLayout", bounds: { left: 0, top: 0, right: 1080, bottom: 2340 } },
          },
        },
        screenWidth: 1080,
        screenHeight: 2340,
        nativeScale: 1,
        pixelWidth: 1080,
        pixelHeight: 2340,
      } as any;
      server.pushHierarchyUpdate("android-1", androidFrame);

      const [message] = socket.getWrittenMessages<any>();
      expect(message.coordinateSpace).toBe("px");
      expect(message.data.hierarchy.node.$.bounds).toEqual({
        left: 0,
        top: 0,
        right: 1080,
        bottom: 2340,
      });
    });

    it("stamps coordinateSpace:px on a screenshot when the caller declares px", () => {
      const { socket } = server.simulateSubscription({ deviceId: "ios-1" });
      const seq = server.pushHierarchyUpdate("ios-1", iosFrame());
      server.pushScreenshotUpdate(
        "ios-1",
        pngFrame(1170, 2532),
        1170,
        2532,
        {},
        {
          captureSequence: seq ?? undefined,
          coordinateSpace: "px",
          nativeScale: 3,
        },
      );
      const shot = socket.getWrittenMessages<any>().find((m) => m.type === "screenshot_update");
      expect(shot.coordinateSpace).toBe("px");
      expect(shot.nativeScale).toBe(3);
      expect(shot.captureSequence).toBe(seq);
    });

    it("omits coordinateSpace on a screenshot from a legacy (non-px) caller", () => {
      const { socket } = server.simulateSubscription({ deviceId: "ios-legacy" });
      server.pushScreenshotUpdate("ios-legacy", pngFrame(1170, 2532), 1170, 2532, {}, {});
      const shot = socket.getWrittenMessages<any>().find((m) => m.type === "screenshot_update");
      expect(shot.coordinateSpace).toBeUndefined();
      expect(shot.nativeScale).toBeUndefined();
    });
  });

  describe("coordinate-mapping golden vectors: geometry pairing (issue #4547)", () => {
    // Cross-language golden suite, B0 of the canonical-pixel campaign (#4547 -> #4549). Each
    // vector drives the daemon's REAL header-measurement pairing (pixelsMatchClaimedGeometry via
    // pushScreenshotUpdate): the capture identity is echoed on the screenshot exactly when the
    // frame's measured pixels are consistent with the claimed geometry (exact match or swapped
    // orientation — never a scale change, never an unmeasurable frame).
    const goldenFrame = (text: string) =>
      ({
        hierarchy: { node: { $: { class: "Root" }, node: [{ $: { class: "Child", text } }] } },
      }) as any;

    const vectors = loadCoordinateMappingVectors().geometryPairing;

    for (const [index, vector] of vectors.entries()) {
      it(`row ${index}: measured ${vector.measuredWidth}x${vector.measuredHeight} vs claimed ${vector.claimedWidth}x${vector.claimedHeight} -> ${vector.expectedMatch === 1 ? "paired" : "not paired"}`, () => {
        const { socket } = server.simulateSubscription({ deviceId: "device-golden" });

        const captureSequence = server.pushHierarchyUpdate("device-golden", goldenFrame("a"));
        // measuredWidth/Height of -1 encodes an unmeasurable frame (not a decodable PNG header).
        const screenshotBase64 =
          vector.measuredWidth < 0
            ? Buffer.from("not-an-image").toString("base64")
            : pngFrame(vector.measuredWidth, vector.measuredHeight);
        server.pushScreenshotUpdate(
          "device-golden",
          screenshotBase64,
          vector.claimedWidth,
          vector.claimedHeight,
          {},
          { captureSequence: captureSequence ?? undefined },
        );

        const screenshot = socket
          .getWrittenMessages<any>()
          .find((m) => m.type === "screenshot_update");
        if (vector.expectedMatch === 1) {
          expect(screenshot.captureSequence).toBe(captureSequence);
        } else {
          expect(screenshot.captureSequence).toBeUndefined();
        }
      });
    }
  });

  describe("device build-context frames", () => {
    interface BuildFrame {
      type: string;
      deviceId?: string;
      deviceSessionUuid?: string | null;
      packageId?: string;
      timestamp?: number;
      buildKey?: {
        packageId: string;
        versionCode: number;
        versionKey?: string;
        contentHash: string;
      } | null;
    }
    const keyA = { packageId: "app.a", versionCode: 1, contentHash: "hash-a" };
    const keyB = { packageId: "app.b", versionCode: 0, versionKey: "1.2.3", contentHash: "hash-b" };
    const buildFrames = (socket: FakeSocket) =>
      socket
        .getWrittenMessages<BuildFrame>()
        .filter((frame) => frame.type === "device_build_context");
    async function subscribe(deviceSessionUuid?: string): Promise<FakeSocket> {
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({ id: "subscribe", command: "subscribe", deviceSessionUuid }),
      );
      return socket;
    }

    it("routes keys only to their own device; all-device frames retain each device's uuid", () => {
      const a = server.simulateSubscription({ deviceId: "device-a" });
      const b = server.simulateSubscription({ deviceId: "device-b" });
      const all = server.simulateSubscription({});
      server.pushBuildContextUpdate("device-a", "app.a", keyA);
      server.pushBuildContextUpdate("device-b", "app.b", keyB);
      expect(buildFrames(a.socket)).toEqual([
        expect.objectContaining({
          deviceId: "device-a",
          deviceSessionUuid: "session-device-a",
          timestamp: timer.now(),
          buildKey: keyA,
        }),
      ]);
      expect(buildFrames(b.socket)).toEqual([
        expect.objectContaining({
          deviceId: "device-b",
          deviceSessionUuid: "session-device-b",
          buildKey: keyB,
        }),
      ]);
      expect(
        buildFrames(all.socket).map((frame) => [frame.deviceSessionUuid, frame.buildKey]),
      ).toEqual([
        ["session-device-a", keyA],
        ["session-device-b", keyB],
      ]);
    });

    it("replays every known app only to the newly subscribed entitled pane", async () => {
      server.sessionResolver
        .bind("device-a", "session-device-a")
        .bind("device-b", "session-device-b");
      server.pushBuildContextUpdate("device-a", "app.a", keyA);
      server.pushBuildContextUpdate("device-a", "app.b", keyB);
      server.pushBuildContextUpdate("device-b", "app.b", keyB);
      const a = await subscribe("session-device-a");
      expect(buildFrames(a).map((frame) => frame.buildKey)).toEqual([keyA, keyB]);
      const all = await subscribe();
      expect(buildFrames(all).map((frame) => frame.deviceSessionUuid)).toEqual([
        "session-device-a",
        "session-device-a",
        "session-device-b",
      ]);
      expect(buildFrames(a)).toHaveLength(2);
    });

    it("changes and clears replace replay state; unknown contexts emit no key", async () => {
      const all = server.simulateSubscription({});
      server.sessionResolver.bind("device-a", "session-device-a");
      server.pushBuildContextUpdate("device-a", "app.a", {
        ...keyA,
        versionCode: 0,
        contentHash: "",
      });
      expect(buildFrames(all.socket)).toEqual([]);
      server.pushBuildContextUpdate("device-a", "app.a", keyA);
      server.pushBuildContextUpdate("device-a", "app.a", { ...keyA, contentHash: "changed" });
      expect(buildFrames(await subscribe("session-device-a"))[0]?.buildKey?.contentHash).toBe(
        "changed",
      );
      server.pushBuildContextUpdate("device-a", "app.a", null);
      expect(buildFrames(all.socket).at(-1)).toMatchObject({ packageId: "app.a", buildKey: null });
      expect(buildFrames(await subscribe("session-device-a"))).toEqual([]);
    });

    it.each(["started", "ended"] as const)(
      "drops the per-device replay cache when a session is %s",
      async (event) => {
        server.sessionResolver
          .bind("device-a", "session-device-a")
          .bind("device-b", "session-device-b");
        server.pushBuildContextUpdate("device-a", "app.a", keyA);
        server.pushBuildContextUpdate("device-b", "app.b", keyB);
        const record = {
          deviceId: "device-a",
          deviceSessionUuid: "session-device-a",
          platform: "android" as const,
          epochStartedAt: timer.now(),
        };
        if (event === "started") {
          server.pushDeviceSessionStarted(record);
        } else {
          server.pushDeviceSessionEnded(record);
        }
        expect(buildFrames(await subscribe()).map((frame) => frame.buildKey)).toEqual([keyB]);
      },
    );

    it("unbound serials reach only all-device panes and are never replayed under a later uuid", async () => {
      const a = server.simulateSubscription({ deviceId: "device-a" });
      const all = server.simulateSubscription({});
      server.pushBuildContextUpdate("unbound", "app.b", keyB);
      expect(buildFrames(a.socket)).toEqual([]);
      expect(buildFrames(all.socket)[0]).toMatchObject({
        deviceId: "unbound",
        deviceSessionUuid: null,
        buildKey: keyB,
      });
      server.sessionResolver.bind("unbound", "new-session");
      expect(buildFrames(await subscribe("new-session"))).toEqual([]);
    });

    it("quarantine and resolver epoch changes cannot replay an old key", async () => {
      server.sessionResolver.bind("device-a", "session-device-a");
      server.pushBuildContextUpdate("device-a", "app.a", keyA);
      server.sessionResolver.quarantine("device-a");
      expect(buildFrames(await subscribe())).toEqual([]);
      server.sessionResolver.resolveIdentity("device-a").bind("device-a", "new-session");
      expect(buildFrames(await subscribe("new-session"))).toEqual([]);
    });

    it("keeps build keys out of existing hierarchy, screenshot and navigation frames", () => {
      const all = server.simulateSubscription({});
      server.sessionResolver.bind("device-a", "session-device-a");
      server.pushBuildContextUpdate("device-a", "app.a", keyA);
      server.pushHierarchyUpdate("device-a", { hierarchy: {} });
      server.pushScreenshotUpdate("device-a", encodedFrames.jpeg.toString("base64"), 37, 53);
      server.pushNavigationGraphUpdate(
        { appId: "app.a", nodes: [], edges: [], currentScreen: null },
        "device-a",
      );
      const oldFrames = all.socket
        .getWrittenMessages<BuildFrame>()
        .filter((frame) => frame.type !== "device_build_context");
      expect(oldFrames.map((frame) => frame.type)).toEqual([
        "hierarchy_update",
        "screenshot_update",
        "navigation_update",
      ]);
      for (const frame of oldFrames) {
        expect("buildKey" in frame).toBe(false);
      }
    });
  });

  describe("deviceSessionUuid routing (#5259)", () => {
    interface Frame {
      type: string;
      deviceId?: string;
      deviceSessionUuid?: string | null;
      successorSessionUuid?: string;
      platform?: string;
      navigationGraph?: NavigationGraphStreamData;
    }
    const frames = (socket: FakeSocket) => socket.getWrittenMessages<Frame>();
    const hierarchy = { hierarchy: { node: { $: {}, node: [] } } } as any;

    it("stamps deviceId and the resolved deviceSessionUuid on every device frame (AC1)", () => {
      const { socket } = server.simulateSubscription({ deviceId: "emulator-5554" });

      server.pushHierarchyUpdate("emulator-5554", hierarchy);
      server.pushScreenshotUpdate("emulator-5554", "png", 100, 200);
      server.pushPerformanceUpdate("emulator-5554", { fps: 60 } as any);
      server.pushStorageUpdate("emulator-5554", { key: "k" } as any);

      const got = frames(socket).filter((f) => f.type.endsWith("_update"));
      expect(got.length).toBe(4);
      for (const f of got) {
        expect(f.deviceId).toBe("emulator-5554");
        expect(f.deviceSessionUuid).toBe("session-emulator-5554");
      }
    });

    it("isolates two devices by deviceSessionUuid across the observation stream (AC2)", () => {
      const a = server.simulateSubscription({ deviceId: "device-a" });
      const b = server.simulateSubscription({ deviceId: "device-b" });

      server.pushHierarchyUpdate("device-a", hierarchy);
      server.pushHierarchyUpdate("device-b", hierarchy);

      expect(
        frames(a.socket)
          .filter((f) => f.type === "hierarchy_update")
          .map((f) => f.deviceSessionUuid),
      ).toEqual(["session-device-a"]);
      expect(
        frames(b.socket)
          .filter((f) => f.type === "hierarchy_update")
          .map((f) => f.deviceSessionUuid),
      ).toEqual(["session-device-b"]);
    });

    it("yields zero events and stops capture for a stale/retired deviceSessionUuid subscriber (AC4)", () => {
      const { socket } = server.simulateSubscription({
        deviceId: "device-a",
        screenshotIntervalMs: 250,
        hierarchyIntervalMs: 250,
      });
      expect(server.hasSubscriberForDevice("device-a")).toBe(true);
      expect(server.getScreenshotIntervalMsForDevice("device-a")).toBe(250);
      expect(server.getHierarchyIntervalMsForDevice("device-a")).toBe(250);

      // device-a reconnects under a new epoch: the serial now resolves to a new uuid.
      server.sessionResolver.retire("device-a").bind("device-a", "session-device-a-2");

      server.pushHierarchyUpdate("device-a", hierarchy);

      expect(frames(socket).filter((f) => f.type === "hierarchy_update")).toHaveLength(0);
      expect(server.hasSubscriberForDevice("device-a")).toBe(false);
      expect(server.getScreenshotIntervalMsForDevice("device-a")).toBe(3000);
      // Retired subscriber: hierarchy cadence pauses instead of the 1Hz default (#5472).
      expect(server.getHierarchyIntervalMsForDevice("device-a")).toBe(2_147_483_647);
    });

    it("retires the previous uuid when a fake resolver rebinds a device", () => {
      server.sessionResolver.bind("device-a", "session-device-a");
      server.sessionResolver.bind("device-a", "session-device-a-2");

      expect(server.sessionResolver.resolveUuid("device-a")).toBe("session-device-a-2");
      expect(server.sessionResolver.resolveDeviceId("session-device-a")).toBeNull();
      expect(server.sessionResolver.resolveDeviceId("session-device-a-2")).toBe("device-a");
    });

    describe("navigation targeting (AC3, closes #4837)", () => {
      it("targets the device that owns the graph; other panes see nothing", () => {
        const a = server.simulateSubscription({ deviceId: "device-a" });
        const b = server.simulateSubscription({ deviceId: "device-b" });

        server.pushNavigationGraphUpdate(
          { appId: "com.x", nodes: [], edges: [], currentScreen: null },
          "device-a",
        );

        expect(
          frames(a.socket)
            .filter((f) => f.type === "navigation_update")
            .map((f) => f.deviceSessionUuid),
        ).toEqual(["session-device-a"]);
        expect(frames(b.socket).filter((f) => f.type === "navigation_update")).toHaveLength(0);
      });

      it("reaches only all-device subscribers when provenance is unknown (deviceId null)", () => {
        const scoped = server.simulateSubscription({ deviceId: "device-a" });
        const all = server.simulateSubscription({});

        server.pushNavigationGraphUpdate(
          { appId: null, nodes: [], edges: [], currentScreen: null },
          null,
        );

        expect(frames(scoped.socket).filter((f) => f.type === "navigation_update")).toHaveLength(0);
        const allNav = frames(all.socket).filter((f) => f.type === "navigation_update");
        expect(allNav).toHaveLength(1);
        expect(allNav[0].deviceSessionUuid).toBeNull();
      });

      it("echoes the requester's deviceSessionUuid on an on-demand request response", async () => {
        server.sessionResolver.bind("device-a", "session-device-a");
        server.setOnNavigationGraphRequested(async () => ({
          appId: "com.x",
          nodes: [],
          edges: [],
          currentScreen: null,
        }));
        const socket = new FakeSocket();

        await server.processLineForTest(
          socket,
          JSON.stringify({
            id: "r1",
            command: "request_navigation_graph",
            deviceSessionUuid: "session-device-a",
            appId: "com.x",
          }),
        );

        const nav = frames(socket).filter((f) => f.type === "navigation_update");
        expect(nav).toHaveLength(1);
        expect(nav[0].deviceSessionUuid).toBe("session-device-a");
        expect(nav[0].deviceId).toBe("device-a");
      });
    });

    describe("session lifecycle frames (AC5)", () => {
      const record = (
        over: Partial<{ deviceSessionUuid: string; deviceId: string; platform: string }> = {},
      ) => ({
        deviceSessionUuid: "session-device-a",
        deviceId: "device-a",
        platform: "android" as const,
        epochStartedAt: 0,
        ...over,
      });

      it("pushes device_session_started to a matching-uuid and an all-device subscriber", () => {
        server.sessionResolver.bind("device-a", "session-device-a");
        const scoped = server.simulateSubscription({
          deviceId: "device-a",
          deviceSessionUuid: "session-device-a",
        });
        const all = server.simulateSubscription({});
        const other = server.simulateSubscription({ deviceSessionUuid: "session-other" });

        server.pushDeviceSessionStarted(record());

        for (const s of [scoped, all]) {
          const f = frames(s.socket).filter((x) => x.type === "device_session_started");
          expect(f).toHaveLength(1);
          expect(f[0]).toMatchObject({
            deviceSessionUuid: "session-device-a",
            deviceId: "device-a",
            platform: "android",
          });
        }
        expect(
          frames(other.socket).filter((x) => x.type === "device_session_started"),
        ).toHaveLength(0);
      });

      it("pushes device_session_ended with the retired identity", () => {
        server.sessionResolver.bind("device-a", "session-device-a");
        const { socket } = server.simulateSubscription({
          deviceId: "device-a",
          deviceSessionUuid: "session-device-a",
        });
        server.sessionResolver.retire("device-a");
        server.pushDeviceSessionEnded(record());

        const f = frames(socket).filter((x) => x.type === "device_session_ended");
        expect(f).toHaveLength(1);
        expect(f[0]).toMatchObject({
          deviceSessionUuid: "session-device-a",
          deviceId: "device-a",
          platform: "android",
        });
        expect(f[0]).not.toHaveProperty("successorSessionUuid");
        expect(f[0]).not.toHaveProperty("reason");
      });

      it("restore boundary carries reason and restored pushes use the new UUID", () => {
        const registry = new DeviceSessionRegistry(
          timer,
          new FakeIdGenerator(["session-old", "session-new"]),
        );
        registry.onDeviceConnected({ deviceId: "device-a", platform: "android", incarnation: 1 });
        const scoped = server.simulateSubscription({
          deviceId: "device-a",
          deviceSessionUuid: "session-old",
        });
        const all = server.simulateSubscription({});
        server.setDeviceSessionResolver(createRegistryDeviceSessionResolver(registry));
        registry.setLifecycleListener({
          onSessionEnded: (record, options) => server.pushDeviceSessionEnded(record, options),
          onSessionStarted: (record) => server.pushDeviceSessionStarted(record),
        });
        registry.onDeviceConnected({
          deviceId: "device-a",
          platform: "android",
          incarnation: 2,
          retireReason: "superseded-by-restore",
        });
        server.pushPerformanceUpdate("device-a", {
          fps: 60,
          frameTimeMs: 16,
          jankFrames: 0,
          droppedFrames: 0,
          memoryUsageMb: 1,
          cpuUsagePercent: 1,
          touchLatencyMs: null,
          timeToInteractiveMs: null,
          screenName: null,
          isResponsive: true,
          recompositionCount: null,
          recompositionRate: null,
        });
        expect(
          frames(scoped.socket).find((frame) => frame.type === "device_session_ended"),
        ).toMatchObject({ successorSessionUuid: "session-new", reason: "superseded-by-restore" });
        expect(frames(all.socket).map((frame) => [frame.type, frame.deviceSessionUuid])).toEqual([
          ["device_session_ended", "session-old"],
          ["device_session_started", "session-new"],
          ["performance_update", "session-new"],
        ]);
        expect(frames(scoped.socket).some((frame) => frame.type === "performance_update")).toBe(
          false,
        );
      });

      it.each([
        "subscribe",
        "request_observation",
        "request_navigation_graph",
        "subscribe_storage",
      ])("restore-retired id fails %s with typed recovery instructions", async (command) => {
        const registry = new DeviceSessionRegistry(timer, new FakeIdGenerator(["old", "new"]));
        registry.onDeviceConnected({ deviceId: "device-a", platform: "android", incarnation: 1 });
        registry.onDeviceConnected({
          deviceId: "device-a",
          platform: "android",
          incarnation: 2,
          retireReason: "superseded-by-restore",
        });
        server.setDeviceSessionResolver(createRegistryDeviceSessionResolver(registry));
        const socket = new FakeSocket();
        await server.processLineForTest(
          socket,
          JSON.stringify({
            id: "restore-request",
            command,
            deviceSessionUuid: "old",
            packageName: "app",
            fileName: "prefs",
          }),
        );
        const response = frames(socket).find((frame) => frame.id === "restore-request");
        expect(response).toMatchObject({
          success: false,
          code: "DEVICE_SESSION_SUPERSEDED_BY_RESTORE",
        });
        expect(response?.error).toContain("snapshot restore");
        expect(response?.error).toContain("deviceSnapshot");
      });

      it("names the successor on the old epoch's ended frame without widening data routing", () => {
        server.sessionResolver.bind("device-a", "session-a");
        const old = server.simulateSubscription({
          deviceId: "device-a",
          deviceSessionUuid: "session-a",
          hierarchyIntervalMs: 500,
        });
        server.sessionResolver.retire("device-a");
        server.pushDeviceSessionEnded(record({ deviceSessionUuid: "session-a" }), {
          successorSessionUuid: "session-b",
        });
        server.sessionResolver.bind("device-a", "session-b");
        server.pushDeviceSessionStarted(record({ deviceSessionUuid: "session-b" }));

        const ended = frames(old.socket).filter((frame) => frame.type === "device_session_ended");
        expect(ended).toHaveLength(1);
        expect(ended[0]).toMatchObject({
          deviceId: "device-a",
          deviceSessionUuid: "session-a",
          successorSessionUuid: "session-b",
        });
        expect(
          frames(old.socket).filter((frame) => frame.type === "device_session_started"),
        ).toHaveLength(0);
        expect(server.hasSubscriberForDevice("device-a")).toBe(false);
        expect(server.getHierarchyIntervalMsForDevice("device-a")).toBe(2_147_483_647);

        server.pushHierarchyUpdate("device-a", hierarchy);
        expect(
          frames(old.socket).filter((frame) => frame.type === "hierarchy_update"),
        ).toHaveLength(0);

        const next = server.simulateSubscription({
          deviceId: "device-a",
          deviceSessionUuid: "session-b",
          hierarchyIntervalMs: 500,
        });
        expect(server.hasSubscriberForDevice("device-a")).toBe(true);
        expect(server.getHierarchyIntervalMsForDevice("device-a")).toBe(500);
        server.pushHierarchyUpdate("device-a", hierarchy);
        expect(
          frames(next.socket).filter((frame) => frame.type === "hierarchy_update"),
        ).toHaveLength(1);
        expect(
          frames(old.socket).filter((frame) => frame.type === "hierarchy_update"),
        ).toHaveLength(0);
      });
    });
  });

  describe("subscribe_storage / unsubscribe_storage", () => {
    interface StorageSubReq {
      deviceId: string | null;
      packageName: string;
      fileName: string;
      subscribe: boolean;
    }

    it("starts subscriber setup before a concurrently received storage subscription", async () => {
      const callOrder: string[] = [];
      server.setOnSubscriberConnected(() => {
        callOrder.push("subscriber");
      });
      server.setOnStorageSubscriptionRequested(async () => {
        callOrder.push("storage");
      });

      const socket = new FakeSocket();
      await Promise.all([
        server.processLineForTest(
          socket,
          JSON.stringify({
            id: "stream-subscribe",
            command: "subscribe",
            deviceId: "emulator-5554",
          }),
        ),
        server.processLineForTest(
          socket,
          JSON.stringify({
            id: "storage-subscribe",
            command: "subscribe_storage",
            deviceId: "emulator-5554",
            packageName: "com.example.app",
            fileName: "prefs.xml",
          }),
        ),
      ]);

      expect(callOrder).toEqual(["subscriber", "storage"]);
    });

    it("invokes the callback with the raw deviceId and acknowledges a subscribe", async () => {
      const calls: StorageSubReq[] = [];
      server.setOnStorageSubscriptionRequested(async (req) => {
        calls.push(req);
      });

      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-1",
          command: "subscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );

      expect(calls).toEqual([
        {
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
          subscribe: true,
        },
      ]);
      const msgs = socket.getWrittenMessages<{ id?: string; type: string; success?: boolean }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("subscription_response");
      expect(msgs[0].id).toBe("s-1");
      expect(msgs[0].success).toBe(true);
    });

    // FUNNEL 2. The session-keyed target above resolves through
    // `resolveDeviceId`, which already withholds a quarantined serial; the RAW
    // `deviceId` target skips that resolution entirely, so it needs the gate to
    // avoid registering a device-side content observer on a runtime the pool can
    // no longer identify
    // ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
    it("refuses a raw-serial storage subscribe while the pooled identity is quarantined", async () => {
      const calls: StorageSubReq[] = [];
      server.setOnStorageSubscriptionRequested(async (req) => {
        calls.push(req);
      });
      server.sessionResolver.quarantine("emulator-5554");

      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-quarantined",
          command: "subscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );

      expect(calls).toEqual([]);
      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
        error?: string;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].success).toBe(false);
      expect(msgs[0].error).toContain("emulator-5554");
    });

    // Teardown is exempt: refusing an unsubscribe would strand the device-side
    // observer the daemon itself registered, and releasing it touches only
    // bookkeeping the quarantine does not call into question.
    it("still releases a raw-serial storage subscription while quarantined", async () => {
      const calls: StorageSubReq[] = [];
      server.setOnStorageSubscriptionRequested(async (req) => {
        calls.push(req);
      });
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-live",
          command: "subscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );
      calls.length = 0;
      server.sessionResolver.quarantine("emulator-5554");

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-release",
          command: "unsubscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );

      expect(calls[0].subscribe).toBe(false);
    });

    it("passes subscribe:false for an unsubscribe", async () => {
      const calls: StorageSubReq[] = [];
      server.setOnStorageSubscriptionRequested(async (req) => {
        calls.push(req);
      });

      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-2-subscribe",
          command: "subscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );
      calls.length = 0;
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-2",
          command: "unsubscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );

      expect(calls[0].subscribe).toBe(false);
      expect(socket.getWrittenMessages<{ type: string }>()[0].type).toBe("subscription_response");
    });

    it("waits to acknowledge storage subscription until the device registration completes", async () => {
      let completeRegistration: (() => void) | undefined;
      server.setOnStorageSubscriptionRequested(
        () =>
          new Promise<void>((resolve) => {
            completeRegistration = resolve;
          }),
      );
      const socket = new FakeSocket();

      const request = server.processLineForTest(
        socket,
        JSON.stringify({
          id: "storage-await",
          command: "subscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(socket.getWrittenMessages()).toEqual([]);
      expect(completeRegistration).toBeDefined();
      completeRegistration!();
      await request;
      expect(socket.getWrittenMessages<{ id?: string; success?: boolean }>()).toEqual([
        expect.objectContaining({ id: "storage-await", success: true }),
      ]);
    });

    it("serializes lifecycle commands for one storage file", async () => {
      const calls: StorageSubReq[] = [];
      let releaseSubscribe: (() => void) | undefined;
      server.setOnStorageSubscriptionRequested(
        (request) =>
          new Promise<void>((resolve) => {
            calls.push(request);
            if (request.subscribe) {
              releaseSubscribe = resolve;
            } else {
              resolve();
            }
          }),
      );
      const socket = new FakeSocket();

      const subscribe = server.processLineForTest(
        socket,
        JSON.stringify({
          id: "storage-subscribe",
          command: "subscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );
      await Promise.resolve();
      const unsubscribe = server.processLineForTest(
        socket,
        JSON.stringify({
          id: "storage-unsubscribe",
          command: "unsubscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );
      await Promise.resolve();

      expect(calls).toEqual([expect.objectContaining({ fileName: "prefs.xml", subscribe: true })]);
      releaseSubscribe?.();
      await Promise.all([subscribe, unsubscribe]);
      expect(calls).toEqual([
        expect.objectContaining({ fileName: "prefs.xml", subscribe: true }),
        expect.objectContaining({ fileName: "prefs.xml", subscribe: false }),
      ]);
    });

    it("resolves a deviceSessionUuid to its serial before invoking the callback", async () => {
      server.sessionResolver.bind("emulator-5556", "session-emulator-5556");
      const calls: StorageSubReq[] = [];
      server.setOnStorageSubscriptionRequested(async (req) => {
        calls.push(req);
      });

      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-3",
          command: "subscribe_storage",
          deviceSessionUuid: "session-emulator-5556",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );

      expect(calls[0].deviceId).toBe("emulator-5556");
    });

    it("rejects a supplied-but-unresolved deviceSessionUuid without invoking the callback", async () => {
      // A stale/unknown UUID must NOT fall through to a null (all-device) target: daemon.ts treats
      // null as every device, so the observer would otherwise be registered/released on every
      // Android device and still ack success (#4709 review).
      let invoked = false;
      server.setOnStorageSubscriptionRequested(async () => {
        invoked = true;
      });

      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-unresolved",
          command: "subscribe_storage",
          deviceSessionUuid: "session-unknown",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );

      expect(invoked).toBe(false);
      const msgs = socket.getWrittenMessages<{ type: string; success?: boolean; error?: string }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].success).toBe(false);
      expect(msgs[0].error).toBe(
        "deviceSessionUuid 'session-unknown' does not identify a live device session",
      );
    });

    it("rejects an unresolved deviceSessionUuid on unsubscribe too", async () => {
      let invoked = false;
      server.setOnStorageSubscriptionRequested(async () => {
        invoked = true;
      });

      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-unresolved-unsub",
          command: "unsubscribe_storage",
          deviceSessionUuid: "session-unknown",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );

      expect(invoked).toBe(false);
      expect(socket.getWrittenMessages<{ type: string }>()[0].type).toBe("error");
    });

    it("rejects a malformed (non-string) deviceSessionUuid without invoking the callback", async () => {
      let invoked = false;
      server.setOnStorageSubscriptionRequested(async () => {
        invoked = true;
      });

      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-malformed",
          command: "subscribe_storage",
          deviceSessionUuid: 42,
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );

      expect(invoked).toBe(false);
      const msgs = socket.getWrittenMessages<{ type: string; error?: string }>();
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].error).toBe("deviceSessionUuid must be a string or null");
    });

    it("rejects a request missing packageName or fileName without invoking the callback", async () => {
      let invoked = false;
      server.setOnStorageSubscriptionRequested(async () => {
        invoked = true;
      });

      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-4",
          command: "subscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
        }),
      );

      expect(invoked).toBe(false);
      const msgs = socket.getWrittenMessages<{ type: string; success?: boolean; error?: string }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].success).toBe(false);
    });

    it("acknowledges success even when no callback is configured (fire-and-forget)", async () => {
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-5",
          command: "subscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );

      const msgs = socket.getWrittenMessages<{ type: string; success?: boolean }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("subscription_response");
      expect(msgs[0].success).toBe(true);
    });

    it("keeps a shared observer until its final desktop owner unsubscribes", async () => {
      const calls: StorageSubReq[] = [];
      server.setOnStorageSubscriptionRequested(async (request) => {
        calls.push(request);
      });
      const first = new FakeSocket();
      const second = new FakeSocket();
      const subscribe = (socket: FakeSocket, id: string) =>
        server.processLineForTest(
          socket,
          JSON.stringify({
            id,
            command: "subscribe_storage",
            deviceId: "emulator-5554",
            packageName: "com.example.app",
            fileName: "prefs.xml",
          }),
        );
      const unsubscribe = (socket: FakeSocket, id: string) =>
        server.processLineForTest(
          socket,
          JSON.stringify({
            id,
            command: "unsubscribe_storage",
            deviceId: "emulator-5554",
            packageName: "com.example.app",
            fileName: "prefs.xml",
          }),
        );

      await subscribe(first, "subscribe-first");
      await subscribe(second, "subscribe-second");
      await unsubscribe(first, "unsubscribe-first");
      expect(calls).toEqual([expect.objectContaining({ subscribe: true, fileName: "prefs.xml" })]);

      await unsubscribe(second, "unsubscribe-second");
      expect(calls).toEqual([
        expect.objectContaining({ subscribe: true, fileName: "prefs.xml" }),
        expect.objectContaining({ subscribe: false, fileName: "prefs.xml" }),
      ]);
    });

    it("releases only a closing socket's final owned observers", async () => {
      const calls: StorageSubReq[] = [];
      const secondaryReleased = Promise.withResolvers<void>();
      const sharedReleased = Promise.withResolvers<void>();
      server.setOnStorageSubscriptionRequested(async (request) => {
        calls.push(request);
        if (!request.subscribe && request.fileName === "secondary.xml") {
          secondaryReleased.resolve();
        }
        if (!request.subscribe && request.fileName === "prefs.xml") {
          sharedReleased.resolve();
        }
      });
      const first = new FakeSocket();
      const second = new FakeSocket();
      const subscribe = (socket: FakeSocket, id: string, fileName: string) =>
        server.processLineForTest(
          socket,
          JSON.stringify({
            id,
            command: "subscribe_storage",
            deviceId: "emulator-5554",
            packageName: "com.example.app",
            fileName,
          }),
        );

      await subscribe(first, "first-shared", "prefs.xml");
      await subscribe(first, "first-secondary", "secondary.xml");
      await subscribe(second, "second-shared", "prefs.xml");

      server.closeConnectionForTest(first);
      await secondaryReleased.promise;
      expect(calls).toEqual([
        expect.objectContaining({ subscribe: true, fileName: "prefs.xml" }),
        expect.objectContaining({ subscribe: true, fileName: "secondary.xml" }),
        expect.objectContaining({ subscribe: false, fileName: "secondary.xml" }),
      ]);

      server.closeConnectionForTest(second);
      await sharedReleased.promise;
      expect(calls).toEqual([
        expect.objectContaining({ subscribe: true, fileName: "prefs.xml" }),
        expect.objectContaining({ subscribe: true, fileName: "secondary.xml" }),
        expect.objectContaining({ subscribe: false, fileName: "secondary.xml" }),
        expect.objectContaining({ subscribe: false, fileName: "prefs.xml" }),
      ]);
    });

    it("keeps the observer when a session UUID rotates before the retired socket closes", async () => {
      const calls: StorageSubReq[] = [];
      server.setOnStorageSubscriptionRequested(async (request) => {
        calls.push(request);
      });
      server.sessionResolver.bind("emulator-5554", "session-old");
      const retiredSocket = new FakeSocket();
      await server.processLineForTest(
        retiredSocket,
        JSON.stringify({
          id: "subscribe-old",
          command: "subscribe_storage",
          deviceSessionUuid: "session-old",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );

      server.sessionResolver.bind("emulator-5554", "session-new");
      const refreshedSocket = new FakeSocket();
      await server.processLineForTest(
        refreshedSocket,
        JSON.stringify({
          id: "subscribe-new",
          command: "subscribe_storage",
          deviceSessionUuid: "session-new",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );
      server.closeConnectionForTest(retiredSocket);

      expect(calls).toEqual([expect.objectContaining({ subscribe: true, fileName: "prefs.xml" })]);
    });

    it("retries a failed final-owner teardown when that socket closes", async () => {
      const calls: StorageSubReq[] = [];
      let failTeardown = true;
      server.setOnStorageSubscriptionRequested(async (request) => {
        calls.push(request);
        if (!request.subscribe && failTeardown) {
          failTeardown = false;
          throw new Error("runner unavailable");
        }
      });
      const socket = new FakeSocket();
      const request = (id: string, command: "subscribe_storage" | "unsubscribe_storage") =>
        server.processLineForTest(
          socket,
          JSON.stringify({
            id,
            command,
            deviceId: "emulator-5554",
            packageName: "com.example.app",
            fileName: "prefs.xml",
          }),
        );

      await request("subscribe", "subscribe_storage");
      await request("unsubscribe", "unsubscribe_storage");
      server.closeConnectionForTest(socket);
      await Promise.resolve();
      await Promise.resolve();

      expect(calls).toEqual([
        expect.objectContaining({ subscribe: true }),
        expect.objectContaining({ subscribe: false }),
        expect.objectContaining({ subscribe: false }),
      ]);
    });

    it("retries a failed final-owner teardown when a socket error is followed by close", async () => {
      const calls: StorageSubReq[] = [];
      let failTeardown = true;
      let notifyFailedTeardown: (() => void) | undefined;
      const failedTeardown = new Promise<void>((resolve) => {
        notifyFailedTeardown = resolve;
      });
      let notifyRetriedTeardown: (() => void) | undefined;
      const retriedTeardown = new Promise<void>((resolve) => {
        notifyRetriedTeardown = resolve;
      });
      server.setOnStorageSubscriptionRequested(async (request) => {
        calls.push(request);
        if (!request.subscribe && failTeardown) {
          failTeardown = false;
          notifyFailedTeardown?.();
          throw new Error("runner unavailable");
        }
        if (!request.subscribe) {
          notifyRetriedTeardown?.();
        }
      });
      const socket = new FakeSocket();
      const request = (id: string) =>
        server.processLineForTest(
          socket,
          JSON.stringify({
            id,
            command: "subscribe_storage",
            deviceId: "emulator-5554",
            packageName: "com.example.app",
            fileName: "prefs.xml",
          }),
        );

      await request("subscribe_storage");
      server.errorConnectionForTest(socket);
      await failedTeardown;
      server.closeConnectionForTest(socket);
      await retriedTeardown;

      expect(calls).toEqual([
        expect.objectContaining({ subscribe: true }),
        expect.objectContaining({ subscribe: false }),
        expect.objectContaining({ subscribe: false }),
      ]);
    });

    it("does not retain a closed socket after its final teardown fails", async () => {
      const calls: StorageSubReq[] = [];
      let notifyFailedTeardown: (() => void) | undefined;
      const failedTeardown = new Promise<void>((resolve) => {
        notifyFailedTeardown = resolve;
      });
      server.setOnStorageSubscriptionRequested(async (request) => {
        calls.push(request);
        if (!request.subscribe) {
          notifyFailedTeardown?.();
          throw new Error("runner unavailable");
        }
      });
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "subscribe_storage",
          command: "subscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );

      server.closeConnectionForTest(socket);
      await failedTeardown;
      server.closeConnectionForTest(socket);
      await Promise.resolve();

      expect(calls).toEqual([
        expect.objectContaining({ subscribe: true }),
        expect.objectContaining({ subscribe: false }),
      ]);
    });

    it("retries a shared observer after concurrent registration failures", async () => {
      const calls: StorageSubReq[] = [];
      server.setOnStorageSubscriptionRequested(async (request) => {
        calls.push(request);
        throw new Error("runner unavailable");
      });
      const subscribe = (socket: FakeSocket, id: string) =>
        server.processLineForTest(
          socket,
          JSON.stringify({
            id,
            command: "subscribe_storage",
            deviceId: "emulator-5554",
            packageName: "com.example.app",
            fileName: "prefs.xml",
          }),
        );

      const first = new FakeSocket();
      const firstRequest = subscribe(first, "subscribe-first");
      await Promise.resolve();
      const second = new FakeSocket();
      await Promise.all([firstRequest, subscribe(second, "subscribe-second")]);

      expect(calls).toHaveLength(1);
      for (const socket of [first, second]) {
        expect(socket.getWrittenMessages<{ type: string; success?: boolean }>()[0]).toMatchObject({
          type: "error",
          success: false,
        });
      }

      server.setOnStorageSubscriptionRequested(async (request) => {
        calls.push(request);
      });
      const retry = new FakeSocket();
      await subscribe(retry, "subscribe-retry");

      expect(calls).toHaveLength(2);
      expect(retry.getWrittenMessages<{ type: string; success?: boolean }>()[0]).toMatchObject({
        type: "subscription_response",
        success: true,
      });
    });

    it("replays active observers when the Android CtrlProxy reconnects", async () => {
      const calls: StorageSubReq[] = [];
      server.setOnStorageSubscriptionRequested(async (request) => {
        calls.push(request);
      });
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "subscribe",
          command: "subscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );

      await server.reapplyStorageSubscriptionsForDevice("emulator-5554");

      expect(calls).toEqual([
        expect.objectContaining({ subscribe: true, fileName: "prefs.xml" }),
        expect.objectContaining({ subscribe: true, fileName: "prefs.xml" }),
      ]);
      expect(
        socket
          .getWrittenMessages<{ type: string; packageName?: string; fileName?: string }>()
          .at(-1),
      ).toMatchObject({
        type: "storage_reconciliation_required",
        packageName: "com.example.app",
        fileName: "prefs.xml",
      });
    });
  });
  // Stream routing while the pool cannot say WHICH AVD is on a serial (#6863
  // review). The pooled entry keeps its session and its epoch, but a possible
  // replacement's passive frames must not reach the previous AVD's subscribers —
  // nor anyone else, since the serial they are attributed to is the only thing
  // the daemon still knows about them.
  describe("unresolved pooled identity", () => {
    const frame = (text: string) =>
      ({ hierarchy: { node: { $: { class: "Root", text } } } }) as any;

    it("drops device-attributed frames while routing is suspended", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });
      server.sessionResolver.quarantine("device-1");

      server.pushHierarchyUpdate("device-1", frame("a"));

      expect(socket.getWrittenMessages()).toHaveLength(0);
    });

    it("drops them for all-device subscribers too, not just the previous epoch's", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });
      const all = server.simulateSubscription({});
      server.sessionResolver.quarantine("device-1");

      server.pushHierarchyUpdate("device-1", frame("a"));

      expect(socket.getWrittenMessages()).toHaveLength(0);
      expect(all.socket.getWrittenMessages()).toHaveLength(0);
    });

    it("keeps routing every other device's frames", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-2" });
      server.sessionResolver.quarantine("device-1");

      server.pushHierarchyUpdate("device-2", frame("a"));

      expect(socket.getWrittenMessages()).toHaveLength(1);
    });

    it("resumes routing under the same uuid once the quarantine lifts", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });
      server.sessionResolver.quarantine("device-1");
      server.pushHierarchyUpdate("device-1", frame("a"));

      server.sessionResolver.resolveIdentity("device-1");
      server.pushHierarchyUpdate("device-1", frame("b"));

      const messages = socket.getWrittenMessages<{ type: string; deviceSessionUuid: string }>();
      expect(messages).toHaveLength(1);
      expect(messages[0].deviceSessionUuid).toBe(sessionUuidFor("device-1"));
    });
  });
});

describe("DeviceDataStreamSocketServer control command authorization (#7950)", () => {
  function setup(env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv) {
    const authenticator = new SessionScopedStreamAuthenticator(
      () => ({
        getSession: (uuid) => (uuid === "owner" || uuid === "intruder" ? {} : null),
        getSessionForDevice: (deviceId) => (deviceId === "device-1" ? "owner" : null),
        getDeviceLabels: () => undefined,
      }),
      "observationStream",
      env,
    );
    const server = new TestableDeviceDataStreamSocketServer(new FakeTimer(), authenticator);
    server.sessionResolver.bind("device-1", "epoch-1");
    const socket = new FakeSocket();
    const calls: string[] = [];
    server.setOnObservationRequested(async (request) => {
      calls.push(`observe:${request.deviceId}`);
      return [
        {
          deviceId: "device-1",
          observation: {
            updatedAt: "2026-06-24T00:00:00.000Z",
            screenSize: { width: 1080, height: 1920 },
            systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
            viewHierarchy: { updatedAt: 1, packageName: "app", hierarchy: {} },
          } as ObserveResult,
        },
      ];
    });
    server.setOnNavigationGraphRequested(async () => {
      calls.push("navigation");
      return null;
    });
    server.setOnStorageSubscriptionRequested(async (request) => {
      calls.push(`${request.subscribe ? "subscribe" : "unsubscribe"}:${request.deviceId}`);
    });
    const send = async (request: Record<string, unknown>) => {
      await server.processLineForTest(socket, JSON.stringify({ id: "auth", ...request }));
      return socket
        .getWrittenMessages<{ type: string; success?: boolean; error?: string }>()
        .at(-1);
    };
    return { server, calls, send };
  }

  const commands = [
    { command: "request_observation", deviceId: "device-1" },
    { command: "request_navigation_graph", deviceSessionUuid: "epoch-1" },
    {
      command: "subscribe_storage",
      deviceSessionUuid: "epoch-1",
      packageName: "app",
      fileName: "prefs",
    },
    {
      command: "unsubscribe_storage",
      deviceSessionUuid: "epoch-1",
      packageName: "app",
      fileName: "prefs",
    },
  ];

  for (const request of commands) {
    it(`${request.command} rejects a missing session before device work`, async () => {
      const { calls, send } = setup();
      const response = await send(request);
      expect(response).toMatchObject({ type: "error", success: false });
      expect(response?.error).toContain("authenticated daemon session");
      expect(calls).toEqual([]);
    });

    // Watching a held device is allowed for any live identity (#10830): these are reads.
    it(`${request.command} admits a live non-owner as a read-only viewer`, async () => {
      const { calls, send } = setup();
      const response = await send({ ...request, sessionUuid: "intruder" });
      expect(response).toMatchObject({ type: "subscription_response", success: true });
      // An unsubscribe with no prior subscribe has no observer to release.
      expect(calls).toHaveLength(request.command === "unsubscribe_storage" ? 0 : 1);
    });

    it(`${request.command} still rejects an unknown session before device work`, async () => {
      const { calls, send } = setup();
      const response = await send({ ...request, sessionUuid: "stranger" });
      expect(response).toMatchObject({ type: "error", success: false });
      expect(response?.error).toContain("not an active daemon session");
      expect(calls).toEqual([]);
    });

    it(`${request.command} honors the stream-auth escape hatch`, async () => {
      const { send } = setup({ AUTOMOBILE_DAEMON_STREAM_AUTH: "0" } as NodeJS.ProcessEnv);
      const response = await send(request);
      expect(response?.success).toBe(true);
    });
  }

  it("all-device observation and storage still require a live session", async () => {
    const { calls, send } = setup();
    const observation = await send({ command: "request_observation" });
    const storage = await send({
      command: "subscribe_storage",
      packageName: "app",
      fileName: "prefs",
    });
    expect(observation?.error).toContain("authenticated daemon session");
    expect(storage?.error).toContain("authenticated daemon session");
    expect(calls).toEqual([]);
  });

  it("the owning session can request observation by live epoch", async () => {
    const { calls, send } = setup();
    const response = await send({
      command: "request_observation",
      deviceSessionUuid: "epoch-1",
      sessionUuid: "owner",
    });
    expect(response).toMatchObject({ type: "subscription_response", success: true });
    expect(calls).toEqual(["observe:device-1"]);
  });

  it("the owning session can request a navigation graph by live epoch", async () => {
    const { calls, send } = setup();
    const response = await send({
      command: "request_navigation_graph",
      deviceSessionUuid: "epoch-1",
      sessionUuid: "owner",
    });
    expect(response).toMatchObject({ type: "subscription_response", success: true });
    expect(calls).toEqual(["navigation"]);
  });

  it("rejects a stale navigation epoch without calling the graph provider", async () => {
    const { calls, send } = setup();
    const response = await send({
      command: "request_navigation_graph",
      deviceSessionUuid: "stale",
      sessionUuid: "owner",
    });
    expect(response).toMatchObject({ type: "error", success: false });
    expect(response?.error).toContain("does not identify a live device session");
    expect(calls).toEqual([]);
  });

  it("the owning session can subscribe and unsubscribe storage by live epoch", async () => {
    const { calls, send } = setup();
    for (const command of ["subscribe_storage", "unsubscribe_storage"]) {
      const response = await send({
        command,
        deviceSessionUuid: "epoch-1",
        sessionUuid: "owner",
        packageName: "app",
        fileName: "prefs",
      });
      expect(response).toMatchObject({ type: "subscription_response", success: true });
    }
    expect(calls).toEqual(["subscribe:device-1", "unsubscribe:device-1"]);
  });
});

streamSubscribeAuthCases("observation-stream", (timer, authenticator) => {
  const server = new TestableDeviceDataStreamSocketServer(timer, authenticator);
  let connected = 0;
  let cadence = 0;
  server.setOnSubscriberConnected(() => {
    connected++;
  });
  server.setOnScreenshotCadenceChanged(() => {
    cadence++;
  });
  server.setOnHierarchyCadenceChanged(() => {
    cadence++;
  });
  return {
    receive: (socket, line) => server.processLineForTest(socket, line),
    getSubscriberCount: () => server.getSubscriberCount(),
    effects: () => {
      expect(cadence).toBe(connected * 2);
      return connected;
    },
  };
});

it("registered observer request_observation passes both auth layers on unowned and held devices (#10830)", async () => {
  const timer = new FakeTimer();
  const registry = new ObserverSessionRegistry(timer);
  registry.register("desktop", "AutoMobile Desktop");
  const options = {
    operation: "observationStream",
    env: {},
    resolveObserverRegistry: () => registry,
    resolveSessionManager: () => ({
      getSession: () => null,
      getDeviceLabels: () => undefined,
      getSessionForDevice: (id: string) => (id === "owned" ? "other" : null),
    }),
  };
  const server = new TestableDeviceDataStreamSocketServer(
    timer,
    new ObserverAdmittingStreamAuthenticator(options),
  );
  let captures = 0;
  server.setOnObservationRequested(async ({ sessionUuid, deviceId }) => {
    new ObserverAdmittingStreamAuthenticator(options).authorize({
      sessionUuid,
      deviceId: deviceId ?? undefined,
      admitViewer: true,
    });
    captures++;
    return [
      {
        deviceId: deviceId ?? "unowned",
        observation: {
          display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
          observationId: "auth-observation",
          updatedAt: 1,
          screenSize: { width: 100, height: 100 },
          systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
          viewHierarchy: { hierarchy: {}, updatedAt: 1 },
        },
      },
    ];
  });
  const socket = new FakeSocket();
  await server.processLineForTest(
    socket,
    JSON.stringify({
      id: "observe",
      command: "request_observation",
      deviceId: "unowned",
      sessionUuid: "desktop",
    }),
  );
  expect(socket.getWrittenMessages()).toEqual([
    { id: "observe", type: "subscription_response", success: true },
  ]);
  expect(captures).toBe(1);
  socket.resetWrittenData();
  await server.processLineForTest(
    socket,
    JSON.stringify({
      id: "watch-held",
      command: "request_observation",
      deviceId: "owned",
      sessionUuid: "desktop",
    }),
  );
  expect(captures).toBe(2);
  expect(socket.getWrittenMessages()).toEqual([
    { id: "watch-held", type: "subscription_response", success: true },
  ]);
  socket.resetWrittenData();
  await server.processLineForTest(
    socket,
    JSON.stringify({
      id: "refuse-unregistered",
      command: "request_observation",
      deviceId: "owned",
      sessionUuid: "unregistered",
    }),
  );
  expect(captures).toBe(2);
  expect(socket.getWrittenMessages<{ error: string; type: string }>()[0]).toMatchObject({
    type: "error",
    error: expect.stringContaining("not an active daemon session"),
  });
});
