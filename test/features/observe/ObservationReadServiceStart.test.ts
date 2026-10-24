import { RunnerReadinessError } from "../../../src/ctrlProxy/RunnerReadinessError";
import {
  RunnerLaunchQueuedError,
  findRunnerLaunchQueuedError,
} from "../../../src/ctrlProxy/ios/RunnerLaunchQueuedError";
import { FakeIosRunnerLaunchGate } from "../../fakes/FakeIosRunnerLaunchGate";
import { wireCapture } from "../../helpers/wireCapture";
import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import iosFixture from "../../fixtures/observe/ios-fractional-bounds.json";
import type { ViewHierarchyResult } from "../../../src/models";
import type { RunnerReadinessRequest } from "../../../src/ctrlProxy/RunnerReadinessService";
import {
  ObservationReadServiceStart,
  daemonObservationServiceOwnershipGuard,
} from "../../../src/features/observe/ObservationReadServiceStart";
import {
  createDeviceHierarchyCapture,
  type HierarchySyncClient,
} from "../../../src/features/observe/DeviceHierarchyCapture";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { ActionableError } from "../../../src/models/ActionableError";
import { DaemonState } from "../../../src/daemon/daemonState";
import {
  acquireDeviceReadinessLock,
  deviceReadinessLockKey,
} from "../../../src/utils/deviceReadinessLock";
import { raceWithDeadline } from "../../../src/utils/raceWithDeadline";
import { logger } from "../../../src/utils/logger";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeScreenshotStateStore } from "../../fakes/FakeScreenshotStateStore";
import { observationServiceStartHarness } from "../../helpers/observationServiceStartHarness";
import { drainUntil, drainMicrotasks } from "../../helpers/fakeTimerStepping";
import { observeToolResultSchema } from "../../../src/server/toolOutputSchemas";
import {
  sanitizeObserveResult,
  projectSanitizedObserveSkeleton,
} from "../../../src/features/observe/output/ObserveResultOutput";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) {
    close();
  }
});

async function harness(platform: "android" | "ios" = "android") {
  const base = await observationServiceStartHarness(platform);
  cleanups.push(base.close);
  let connected = false;
  let calls = 0;
  let closes = 0;
  let admitted = 0;
  let canStart = true;
  let onSetup: ((request: RunnerReadinessRequest) => Promise<void>) | undefined;
  const hierarchy: ViewHierarchyResult = wireCapture(
    platform === "ios"
      ? { ...structuredClone(iosFixture.viewHierarchy), updatedAt: 1, fresh: true }
      : {
          hierarchy: {
            node: [
              {
                text: "Hello",
                class: "android.widget.Button",
                clickable: "true",
                enabled: "true",
                bounds: { left: 0, top: 0, right: 100, bottom: 100 },
              },
            ],
          },
          packageName: "com.test",
          screenWidth: 100,
          screenHeight: 100,
          updatedAt: 1,
          fresh: true,
        },
  );
  let beforeAdmission: (() => void) | undefined;
  const client: HierarchySyncClient = {
    connectForObservationRead: async () => connected,
    close: async () => {
      closes++;
    },
    requestHierarchySync: async () => ({ hierarchy }),
    requestHierarchySyncForObserver: async () => ({ hierarchy }),
    convertToViewHierarchyResult: () => hierarchy,
  };
  const launchQueue = new FakeIosRunnerLaunchGate();
  const starter = new ObservationReadServiceStart({
    launchQueue,
    timer: base.timer,
    ownershipGuard: {
      canStart: (device) => canStart && daemonObservationServiceOwnershipGuard.canStart(device),
    },
    skipCtrlProxyDownload: () => true,
    isServiceConnected: () => connected,
    readiness: {
      ensureReady: async (request) => {
        calls++;
        const release = await acquireDeviceReadinessLock(
          deviceReadinessLockKey(platform, base.device.deviceId),
          { timer: base.timer, signal: request.signal },
        );
        try {
          beforeAdmission?.();
          request.assertCanSetup?.();
          admitted++;
          expect(request.skipCtrlProxyDownload).toBe(true);
          expect(request.totalDeadlineMs).toBeGreaterThan(base.timer.now());
          expect(request.readinessTimeoutMs).toBeLessThanOrEqual(
            request.totalDeadlineMs - base.timer.now(),
          );
          if (onSetup) {
            await raceWithDeadline(() => onSetup!(request), {
              timer: base.timer,
              signal: request.signal,
              label: "Fake readiness",
            });
          }
          connected = true;
        } finally {
          release();
        }
      },
    },
  });
  const capture = createDeviceHierarchyCapture(base.device, {
    timer: base.timer,
    observationServiceStart: starter,
    observationClientResolver: () => ({ syncClient: client, transient: !connected, owned: false }),
  });
  const factory = new FakeAdbClientFactory(new FakeAdbExecutor());
  const screen = new RealObserveScreen(
    base.device,
    factory,
    {
      deviceReadOnly: true,
      window: new FakeWindow(),
      hierarchyCapture: capture,
      cacheStore: new FakeObserveCacheStore(base.timer),
      screenshotStateStore: new FakeScreenshotStateStore(base.timer),
      screenshot: {
        execute: async () => ({ success: true, path: "/fake/queued.png" }),
        generateScreenshotPath: () => "/fake/queued.png",
        getActivityHash: async () => "",
      },
      screenshotEvidenceFiles: {
        stat: async () => ({ isFile: () => true, size: 12, mtimeMs: 0 }),
      },
    },
    base.timer,
  );
  return {
    ...base,
    capture,
    launchQueue,
    screen,
    starter,
    client,
    calls: () => calls,
    admitted: () => admitted,
    closes: () => closes,
    setConnected: (value: boolean) => {
      connected = value;
    },
    setAllowed: (value: boolean) => {
      canStart = value;
    },
    setBeforeAdmission: (value: () => void) => {
      beforeAdmission = value;
    },
    setSetup: (value: typeof onSetup) => {
      onSetup = value;
    },
    read: (options: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
      capture.capture({ freshness: "fresh", observerMode: true, ...options }),
  };
}

beforeAll(async () => {
  // Pay the one-time cold-start cost of the first read (lazy zod schema build, first-use pool and
  // session wiring; ~15 ms) outside the per-test budget with a throwaway read nothing asserts on.
  const h = await harness("android");
  const result = await h.screen.executeDeviceRead(undefined, "none");
  observeToolResultSchema.safeParse(result);
  projectSanitizedObserveSkeleton(
    sanitizeObserveResult(result, { dropElements: false, project: "full" }),
    result,
  );
  for (const close of cleanups.splice(0)) {
    close();
  }
});

test.each(["android", "ios"] as const)(
  "unowned %s read starts once, returns fresh elements and leaves real pool/session state idle",
  async (platform) => {
    const h = await harness(platform);
    const create = spyOn(h.sessions, "createSession");
    const assign = spyOn(h.pool, "bindOrReuseDeviceSession");
    try {
      expect(h.pool.getDevice(h.device.deviceId)).toMatchObject({
        sessionId: null,
        status: "idle",
        assignmentCount: 0,
      });
      const result = await h.screen.executeDeviceRead(undefined, "none");
      expect(Object.values(result.elements ?? {}).flat().length).toBeGreaterThan(0);
      expect(result.freshness?.category).not.toBe("unavailable");
      expect(result.hierarchyServiceStarted).toBe(true);
      expect(result.freshness?.warning).toBeUndefined();
      expect(observeToolResultSchema.safeParse(result).error).toBeUndefined();
      const sanitized = sanitizeObserveResult(result, { dropElements: false, project: "full" });
      expect(projectSanitizedObserveSkeleton(sanitized, result).hierarchyServiceStarted).toBe(true);
      const later = await h.screen.executeDeviceRead(undefined, "none");
      expect(later.hierarchyServiceStarted).toBeUndefined();
      expect(h.calls()).toBe(1);
      expect(h.closes()).toBe(1); // failed transient only; resident remains
      expect(create).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
      expect(h.sessions.getAllSessions()).toEqual([]);
      expect(h.pool.getDevice(h.device.deviceId)).toMatchObject({
        sessionId: null,
        status: "idle",
        assignmentCount: 0,
      });
    } finally {
      create.mockRestore();
      assign.mockRestore();
    }
  },
);

test.each(["reservation", "shutdown", "deferred release"])(
  "read stays unavailable during %s",
  async (kind) => {
    const h = await harness();
    let release: (() => Promise<void>) | undefined;
    if (kind === "reservation") {
      release = await h.pool.reserveDeviceForReadiness(h.device.deviceId, h.device);
    }
    if (kind === "shutdown") {
      const reservation = await h.pool.reserveDeviceForShutdown(h.device.deviceId);
      release = reservation?.release;
    }
    if (kind === "deferred release") {
      h.pool.testHooks.deferredDeviceReleases.set(h.device.deviceId, {
        device: h.pool.getDevice(h.device.deviceId)!,
        sessionId: "pending",
        assignmentCount: 0,
        cleanup: Promise.resolve(),
      });
    }
    try {
      const result = await h.screen.executeDeviceRead(undefined, "none");
      expect(result.freshness?.unavailableReason).toBe("connection_lost");
      expect(result.freshness?.unavailableDetail).toContain("has no reachable hierarchy service");
      expect(result.freshness?.unavailableDetail).toContain("declined");
      expect(h.calls()).toBe(0);
    } finally {
      await release?.();
    }
  },
);

test("acquisition holding readiness lock declines setup", async () => {
  const h = await harness();
  const release = await acquireDeviceReadinessLock(
    deviceReadinessLockKey("android", h.device.deviceId),
  );
  try {
    await expect(h.read()).rejects.toThrow("readiness is in progress");
    expect(h.calls()).toBe(0);
  } finally {
    release();
  }
});

test("ownership flipping before the lock re-check prevents mutating setup", async () => {
  const h = await harness();
  h.setBeforeAdmission(() => {
    const device = h.pool.getDevice(h.device.deviceId);
    if (!device) {
      throw new Error("Expected pooled device");
    }
    const ownership = spyOn(h.pool, "getDevice").mockReturnValue({
      ...device,
      sessionId: "new-owner",
    });
    cleanups.push(() => ownership.mockRestore());
  });
  await expect(h.read()).rejects.toThrow("changed while waiting for readiness");
  expect(h.calls()).toBe(1);
  expect(h.admitted()).toBe(0);
});

test.each(["setup failed", "setup threw"])(
  "%s remains an unavailable observation and warns with original error",
  async (message) => {
    const h = await harness();
    const error = message === "setup failed" ? new ActionableError(message) : new Error(message);
    h.setSetup(async () => {
      throw error;
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await h.screen.executeDeviceRead(undefined, "none");
      expect(result.freshness?.unavailableReason).toBe("connection_lost");
      expect(result.freshness?.unavailableDetail).toContain(
        `read tried to start the service: ${message}`,
      );
      expect(result.hierarchyServiceStarted).toBeUndefined();
      expect(warn.mock.calls.some((call) => call[1] === error)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  },
);

test("setup exhausting the read deadline stops setup and preserves unavailable detail", async () => {
  const h = await harness();
  let setupSignal: AbortSignal | undefined;
  h.setSetup(async (request) => {
    setupSignal = request.signal;
    await new Promise<void>(() => {});
  });
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const pending = h.screen.executeDeviceRead(undefined, "none");
    await drainUntil(() => h.admitted() === 1, { description: "setup admitted" });
    h.timer.advanceTime(15000);
    const result = await pending;
    expect(setupSignal?.aborted).toBe(true);
    expect(result.freshness?.unavailableReason).toBe("connection_lost");
    expect(result.freshness?.unavailableDetail).toContain("timed out");
    expect(warn).toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test("concurrent reads share setup; a timed out and an aborted waiter cannot cancel other readers", async () => {
  const h = await harness();
  const setup = Promise.withResolvers<void>();
  let setupSignal: AbortSignal | undefined;
  h.setSetup(async (request) => {
    setupSignal = request.signal;
    await setup.promise;
  });
  const first = h.read({ timeoutMs: 100 });
  await drainUntil(() => h.admitted() === 1, { description: "one setup" });
  const timedOut = h.read({ timeoutMs: 10 });
  const controller = new AbortController();
  const aborted = h.read({ timeoutMs: 80, signal: controller.signal });
  const others = [h.read({ timeoutMs: 100 }), h.read({ timeoutMs: 100 })];
  await drainMicrotasks(40);
  controller.abort(new Error("read cancelled"));
  await expect(aborted).rejects.toThrow("read cancelled");
  h.timer.advanceTime(10);
  await expect(timedOut).rejects.toThrow("timed out");
  expect(setupSignal?.aborted).toBe(false);
  setup.resolve();
  for (const result of await Promise.all([first, ...others])) {
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.hierarchy.hierarchyServiceStarted).toBe(true);
  }
  expect(h.calls()).toBe(1);
  await h.read();
  expect(h.calls()).toBe(1);
});

test("the initiating reader may abort while another reader keeps setup alive", async () => {
  const h = await harness();
  const setup = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  h.setSetup(async (request) => {
    signal = request.signal;
    await setup.promise;
  });
  const controller = new AbortController();
  const first = h.read({ signal: controller.signal });
  await drainUntil(() => h.admitted() === 1, { description: "setup" });
  const other = h.read();
  await drainMicrotasks(40);
  controller.abort(new Error("initiator cancelled"));
  await expect(first).rejects.toThrow("initiator cancelled");
  expect(signal?.aborted).toBe(false);
  setup.resolve();
  expect((await other).nodes.length).toBeGreaterThan(0);
});

test.each([false, true])(
  "aborted device read propagates an error (during setup: %s)",
  async (duringSetup) => {
    const h = await harness();
    const controller = new AbortController();
    if (duringSetup) {
      h.setSetup(async () => new Promise<void>(() => {}));
    } else {
      controller.abort(new Error("caller cancelled"));
    }
    const pending = h.screen.executeDeviceRead(controller.signal, "none");
    if (duringSetup) {
      await drainUntil(() => h.admitted() === 1, { description: "setup" });
      controller.abort(new Error("caller cancelled"));
    }
    await expect(pending).rejects.toThrow(/cancelled/);
  },
);

test.each([false, true])("running service skips setup (resident: %s)", async (resident) => {
  const h = await harness();
  h.setConnected(true);
  const capture = resident
    ? h.capture
    : createDeviceHierarchyCapture(h.device, {
        timer: h.timer,
        observationServiceStart: h.starter,
        observationClientResolver: () => ({ syncClient: h.client, transient: true, owned: false }),
      });
  expect(
    (await capture.capture({ freshness: "fresh", observerMode: true })).nodes.length,
  ).toBeGreaterThan(0);
  expect(h.calls()).toBe(0);
});

test("uninitialized daemon stays connect-only", async () => {
  const h = await harness();
  DaemonState.getInstance().reset();
  await expect(h.read()).rejects.toThrow("declined");
  expect(h.calls()).toBe(0);
});

test("acquisition marker remains a transition after the setup lock is released", async () => {
  const h = await harness();
  const { trackDeviceAcquisitionReadiness } =
    await import("../../../src/utils/deviceReadinessLock");
  const pendingAssignment = Promise.withResolvers<void>();
  const acquisition = trackDeviceAcquisitionReadiness(
    deviceReadinessLockKey("android", h.device.deviceId),
    () => pendingAssignment.promise,
  );
  try {
    await expect(h.read()).rejects.toThrow("declined");
    expect(h.calls()).toBe(0);
  } finally {
    pendingAssignment.resolve();
    await acquisition;
  }
});

test("setup and extraction share the original deadline", async () => {
  const h = await harness();
  let readBudget: number | undefined;
  h.setSetup(async () => {
    h.timer.advanceTime(70);
  });
  h.client.requestHierarchySyncForObserver = async (_perf, _raw, _signal, timeout) => {
    readBudget = timeout;
    return new Promise(() => {});
  };
  const pending = h.read({ timeoutMs: 100 });
  await drainUntil(() => readBudget !== undefined, { description: "bounded hierarchy read" });
  expect(readBudget).toBe(30);
  h.timer.advanceTime(30);
  await expect(pending).rejects.toThrow("hierarchy read timed out");
});

test("a delayed stale failed dial reuses the resident service after the first flight finishes", async () => {
  const h = await harness();
  const closed = Promise.withResolvers<void>();
  let closes = 0;
  h.client.close = async () => {
    if (++closes === 2) {
      await closed.promise;
    }
  };
  const first = h.read();
  const delayed = h.read();
  expect((await first).hierarchy.hierarchyServiceStarted).toBe(true);
  expect(h.calls()).toBe(1);
  closed.resolve();
  const later = await delayed;
  expect(later.nodes.length).toBeGreaterThan(0);
  expect(later.hierarchy.hierarchyServiceStarted).toBeUndefined();
  expect(h.calls()).toBe(1);
});

const queuedStatus = { position: 2, ahead: 3, limit: 2 };

test.each([false, true])(
  "queued iOS timeout preserves status (queue clears on abort: %s)",
  async (clearOnAbort) => {
    const h = await harness("ios");
    h.launchQueue.queued.set(h.device.deviceId, queuedStatus);
    h.setSetup(async (request) => {
      if (clearOnAbort) {
        request.signal?.addEventListener("abort", () => h.launchQueue.queued.clear(), {
          once: true,
        });
      }
      await new Promise<void>(() => {});
    });
    const pending = h.starter.start({ device: h.device, deadlineMs: h.timer.now() + 100 });
    const failure = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await drainUntil(() => h.admitted() === 1, { description: "queued setup" });
    h.timer.advanceTime(100);
    const error = await failure;
    expect(error).toBeInstanceOf(RunnerLaunchQueuedError);
    if (!(error instanceof RunnerLaunchQueuedError)) {
      throw new Error("Expected queued error");
    }
    expect(error.deviceId).toBe(h.device.deviceId);
    expect(error.status).toEqual(queuedStatus);
    expect(error.cause).toBeInstanceOf(Error);
    expect(String(error.cause)).toContain("timed out");
    expect(error.message).toContain("queue position 2");
    await drainMicrotasks(40);
    // A later flight must not inherit the timeout snapshot.
    h.launchQueue.queued.clear();
    h.setSetup(async () => new Promise<void>(() => {}));
    const later = h.starter.start({ device: h.device, deadlineMs: h.timer.now() + 100 });
    const laterFailure = later.then(
      () => undefined,
      (error: unknown) => error,
    );
    await drainUntil(() => h.admitted() === 2, { description: "later setup" });
    h.timer.advanceTime(100);
    const laterError = await laterFailure;
    expect(laterError).not.toBeInstanceOf(RunnerLaunchQueuedError);
    expect(String(laterError)).toContain("timed out");
  },
);

test.each(["ios", "android"] as const)(
  "unqueued %s timeout retains the original error",
  async (platform) => {
    const h = await harness(platform);
    const lookup = spyOn(h.launchQueue, "queueStatus");
    h.setSetup(async () => new Promise<void>(() => {}));
    const pending = h.starter.start({ device: h.device, deadlineMs: h.timer.now() + 100 });
    const failure = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await drainUntil(() => h.admitted() === 1, { description: "setup" });
    h.timer.advanceTime(100);
    const error = await failure;
    expect(error).not.toBeInstanceOf(RunnerLaunchQueuedError);
    expect(String(error)).toContain("timed out");
    if (platform === "android") {
      expect(lookup).not.toHaveBeenCalled();
    }
    lookup.mockRestore();
  },
);

test("queued iOS request cancellation retains the caller abort", async () => {
  const h = await harness("ios");
  h.launchQueue.queued.set(h.device.deviceId, queuedStatus);
  h.setSetup(async () => new Promise<void>(() => {}));
  const controller = new AbortController();
  const pending = h.starter.start({
    device: h.device,
    deadlineMs: h.timer.now() + 100,
    signal: controller.signal,
  });
  const failure = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  await drainUntil(() => h.admitted() === 1, { description: "setup" });
  const abort = new Error("caller abort");
  controller.abort(abort);
  expect(await failure).toBe(abort);
});

test("queued iOS non-timeout failure is not relabelled", async () => {
  const h = await harness("ios");
  h.launchQueue.queued.set(h.device.deviceId, queuedStatus);
  h.setSetup(async () => {
    throw new Error("setup failed");
  });
  await expect(
    h.starter.start({ device: h.device, deadlineMs: h.timer.now() + 100 }),
  ).rejects.toThrow("setup failed");
});

test.each([false, true])(
  "cold iOS observation retains screenshot and typed freshness (queued: %s)",
  async (queued) => {
    const h = await harness("ios");
    if (queued) {
      h.launchQueue.queued.set(h.device.deviceId, queuedStatus);
    }
    h.setSetup(async () => new Promise<void>(() => {}));
    const pending = h.screen.executeDeviceRead();
    await drainUntil(() => h.admitted() === 1, { description: "setup" });
    h.timer.advanceTime(15000);
    const result = await pending;
    expect(result.freshness).toMatchObject({
      isFresh: false,
      category: "unavailable",
      unavailableReason: queued ? "runner_launch_queued" : "connection_lost",
    });
    expect(result.screenshotPath).toBe("/fake/queued.png");
    expect(Object.values(result.elements ?? {}).flat()).toHaveLength(0);
    if (queued) {
      expect(result.freshness?.unavailableDetail).toContain("queue position 2");
    }
    expect(observeToolResultSchema.safeParse(result).success).toBe(true);
  },
);

test("queued error lookup follows bounded, cycle-safe causes", () => {
  const queued = new RunnerLaunchQueuedError("ios-device", queuedStatus);
  expect(findRunnerLaunchQueuedError(new ActionableError("wrapper", { cause: queued }))).toBe(
    queued,
  );
  const cycle = new Error("cycle");
  cycle.cause = cycle;
  expect(findRunnerLaunchQueuedError(cycle)).toBeUndefined();
  expect(findRunnerLaunchQueuedError("timeout")).toBeUndefined();
  let deep: Error = queued;
  for (let depth = 0; depth < 40; depth++) {
    deep = new Error("wrapper", { cause: deep });
  }
  expect(findRunnerLaunchQueuedError(deep)).toBeUndefined();
});

test("queued readiness budget exhaustion is typed before the outer read timer fires", async () => {
  const h = await harness("ios");
  h.launchQueue.queued.set(h.device.deviceId, queuedStatus);
  const timeout = new RunnerReadinessError(
    "automation runner readiness failed: remainingBudgetMs=0",
    false,
    true,
  );
  h.setSetup(async () => {
    throw timeout;
  });
  const error = await h.starter.start({ device: h.device, deadlineMs: h.timer.now() + 100 }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(RunnerLaunchQueuedError);
  if (!(error instanceof RunnerLaunchQueuedError)) {
    throw new Error("Expected queued error");
  }
  expect(error.cause).toBe(timeout);
});

test("a shorter queued reader uses the live queue while another reader retains setup", async () => {
  const h = await harness("ios");
  h.launchQueue.queued.set(h.device.deviceId, queuedStatus);
  const setup = Promise.withResolvers<void>();
  let setupSignal: AbortSignal | undefined;
  h.setSetup(async (request) => {
    setupSignal = request.signal;
    await setup.promise;
  });
  const first = h.starter.start({ device: h.device, deadlineMs: h.timer.now() + 100 });
  await drainUntil(() => h.admitted() === 1, { description: "shared setup" });
  const later = h.starter.start({ device: h.device, deadlineMs: h.timer.now() + 10 });
  const failure = later.then(
    () => undefined,
    (error: unknown) => error,
  );
  await drainMicrotasks(20);
  h.timer.advanceTime(10);
  expect(await failure).toBeInstanceOf(RunnerLaunchQueuedError);
  expect(setupSignal?.aborted).toBe(false);
  h.launchQueue.queued.clear();
  setup.resolve();
  expect(await first).toBe(true);
});
