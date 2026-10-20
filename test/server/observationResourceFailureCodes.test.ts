import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { markedHierarchy } from "../helpers/observeFixture";
import type { BootedDevice, ObserveResult } from "../../src/models";
import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import {
  resetObserveCacheStore,
  setObserveCacheStore,
} from "../../src/features/observe/cache/ObserveCacheRegistry";
import {
  InMemoryScreenshotStateStore,
  SCREENSHOT_CAPTURE_CANCELLED_REASON,
  SCREENSHOT_CAPTURE_SUPERSEDED_REASON,
  resetScreenshotStateStore,
  setScreenshotStateStore,
} from "../../src/features/observe/screenshot/ScreenshotStateRegistry";
import {
  RESOURCE_URIS,
  readObservationScreenshotBytes,
  registerObservationResources,
  type ObservationResourceDependencies,
} from "../../src/server/observationResources";
import {
  OBSERVATION_SCREENSHOT_NOT_READY_RETRY_AFTER_MS,
  buildObservationScreenshotUri,
} from "../../src/daemon/observationResourceUris";
import {
  ResourceRegistry,
  type ResourceContent,
  type ResourceReadContext,
} from "../../src/server/resourceRegistry";
import { clearDirectSessionDevices } from "../../src/utils/directSessionDeviceRegistry";
import { ScreenshotJobTracker } from "../../src/utils/ScreenshotJobTracker";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeObserveCacheStore } from "../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../fakes/FakeTimer";

let deps: ObservationResourceDependencies = {};
function useScreenshotFileSystem(
  value: ObservationResourceDependencies["screenshotFileSystem"] | null,
): void {
  deps = { ...deps, screenshotFileSystem: value ?? undefined };
  registerObservationResources(deps);
}
function useSessionScreenshotResourceDependencies(
  value: ObservationResourceDependencies["sessionScreenshotResourceDependencies"] | null,
): void {
  deps = { ...deps, sessionScreenshotResourceDependencies: value ?? undefined };
  registerObservationResources(deps);
}
function clearScreenshotFileSystem(): void {
  deps = { ...deps, screenshotFileSystem: undefined };
}
function clearSessionScreenshotResourceDependencies(): void {
  deps = { ...deps, sessionScreenshotResourceDependencies: undefined };
}

const deviceA: BootedDevice = { deviceId: "device:a", name: "A", platform: "android" };
const deviceB: BootedDevice = { deviceId: "device:b", name: "B", platform: "android" };
const sessionUuid = "session-a";
const sessionUris = [
  `automobile:observation/session/${sessionUuid}/latest`,
  `automobile:observation/session/${sessionUuid}/latest/screenshot`,
];
const images = [
  { mimeType: "image/png", bytes: Buffer.from("89504e470d0a1a0a", "hex") },
  { mimeType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
  { mimeType: "image/webp", bytes: Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "binary") },
];

interface FailureBody {
  code: string;
  retryable: boolean;
  retryAfterMs?: number;
  error: string;
  deviceId?: string;
  observationId?: string;
  sessionUuid?: string;
}

async function read(uri: string, context: ResourceReadContext = {}): Promise<ResourceContent> {
  const resource = ResourceRegistry.getResource(uri);
  if (resource) {
    return resource.handler(context);
  }
  const match = ResourceRegistry.matchTemplate(uri);
  if (!match) {
    throw new Error(`Unregistered test URI: ${uri}`);
  }
  if ("handlerWithReadContext" in match.template) {
    return match.template.handlerWithReadContext(match.params, context);
  }
  return match.template.handler(match.params);
}

function failure(
  content: ResourceContent,
  code: string,
  ids: Pick<FailureBody, "deviceId" | "observationId" | "sessionUuid"> = {},
): FailureBody {
  expect(content.mimeType).toBe("application/json");
  expect(content.blob).toBeUndefined();
  const body: FailureBody = JSON.parse(content.text!);
  expect(body.code).toBe(code);
  expect(body.retryable).toBe(code === "SCREENSHOT_NOT_READY");
  expect(typeof body.error).toBe("string");
  expect(body.error.length).toBeGreaterThan(0);
  expect(body.deviceId).toBe(ids.deviceId);
  expect(body.observationId).toBe(ids.observationId);
  expect(body.sessionUuid).toBe(ids.sessionUuid);
  const keys = ["code", "retryable"];
  if (body.retryable) {
    expect(body.retryAfterMs).toBe(OBSERVATION_SCREENSHOT_NOT_READY_RETRY_AFTER_MS);
    keys.push("retryAfterMs");
  } else {
    expect(body).not.toHaveProperty("retryAfterMs");
  }
  keys.push("error", ...Object.keys(ids));
  expect(Object.keys(body)).toEqual(keys);
  expect(content.text).toBe(JSON.stringify(body, null, 2));
  return body;
}

function image(content: ResourceContent, fixture = images[0]): void {
  expect(content.mimeType).toBe(fixture.mimeType);
  expect(content.blob).toBe(fixture.bytes.toString("base64"));
  expect(content.text).toBeUndefined();
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await Promise.resolve();
  }
}

class UnreadableObservationCache extends FakeObserveCacheStore {
  override getRecentInMemoryEntry(): never {
    throw new Error("observation cache failed");
  }
  override getRecentInMemoryForDevice(): never {
    throw new Error("observation cache failed");
  }
}

// All storage and time are injected; setup only constructs small in-memory fakes.
describe("observation resource failure envelopes", () => {
  let timer: FakeTimer;
  let cache: FakeObserveCacheStore;
  let store: InMemoryScreenshotStateStore;
  let ids: CountingIdGenerator;

  beforeEach(() => {
    timer = new FakeTimer();
    cache = new FakeObserveCacheStore(timer);
    store = new InMemoryScreenshotStateStore(timer);
    ids = new CountingIdGenerator("observation");
    setObserveCacheStore(cache);
    setScreenshotStateStore(store);
    ScreenshotJobTracker.setTimer(timer);
    ScreenshotJobTracker.setIdGenerator(ids);
    useScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async () => images[0].bytes,
    });
    registerObservationResources(deps);
  });

  afterEach(() => {
    RealObserveScreen.clearCache();
    ScreenshotJobTracker.clear();
    ScreenshotJobTracker.resetTimer();
    ScreenshotJobTracker.resetIdGenerator();
    resetScreenshotStateStore();
    resetObserveCacheStore();
    clearScreenshotFileSystem();
    clearSessionScreenshotResourceDependencies();
    clearDirectSessionDevices();
  });

  async function observe(device = deviceA): Promise<ObserveResult> {
    const screen = new RealObserveScreen(
      device,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      { cacheStore: cache },
      timer,
      ids,
    );
    const result = { ...screen.createBaseResult(), viewHierarchy: markedHierarchy(device.name) };
    await screen.cacheObserveResult(result);
    return result;
  }

  function resolveSession(active = true): void {
    useSessionScreenshotResourceDependencies({
      resolveActiveSession: () => (active ? { sessionUuid, device: deviceA } : undefined),
      createScreenshotService: () => {
        throw new Error("Cached resources must not capture");
      },
    });
  }

  test.each(["device%ZZ/observation", "device/observation%ZZ"])(
    "malformed segment %s has no decoded ids",
    async (segments) => {
      const body = failure(
        await read(`automobile:observation/${segments}/screenshot`),
        "INVALID_REQUEST",
      );
      expect(body.error).toBe(
        "Malformed resource URI: a path segment is not valid percent-encoding.",
      );
    },
  );

  test("unknown observation carries decoded device and observation ids", async () => {
    failure(
      await read(buildObservationScreenshotUri(deviceA.deviceId, "unknown:id")),
      "OBSERVATION_NOT_RETAINED",
      {
        deviceId: deviceA.deviceId,
        observationId: "unknown:id",
      },
    );
  });

  test("evicted observation cannot serve its retained image", async () => {
    const { observationId } = await observe();
    store.updateForObservation(deviceA.deviceId, observationId, "/fake/evicted.png");
    cache.clear(deviceA.deviceId);
    failure(
      await read(buildObservationScreenshotUri(deviceA.deviceId, observationId)),
      "OBSERVATION_NOT_RETAINED",
      {
        deviceId: deviceA.deviceId,
        observationId,
      },
    );
  });

  test("superseded URI never serves the newer observation image", async () => {
    const old = await observe();
    const newer = await observe();
    store.updateForObservation(deviceA.deviceId, newer.observationId, "/fake/new.png");
    failure(
      await read(buildObservationScreenshotUri(deviceA.deviceId, old.observationId)),
      "OBSERVATION_NOT_RETAINED",
      {
        deviceId: deviceA.deviceId,
        observationId: old.observationId,
      },
    );
    image(await read(buildObservationScreenshotUri(deviceA.deviceId, newer.observationId)));
  });

  test("pending capture can complete for the SAME URI after the bounded wait", async () => {
    const { observationId } = await observe();
    store.beginObservation(deviceA.deviceId, observationId);
    const uri = buildObservationScreenshotUri(deviceA.deviceId, observationId);
    const pending = read(uri);
    await Promise.resolve();
    timer.advanceTime(10_000);
    const body = failure(await pending, "SCREENSHOT_NOT_READY", {
      deviceId: deviceA.deviceId,
      observationId,
    });
    expect(body.retryAfterMs).toBe(OBSERVATION_SCREENSHOT_NOT_READY_RETRY_AFTER_MS);
    store.updateForObservation(deviceA.deviceId, observationId, "/fake/completed.png");
    image(await read(uri));
  });

  test.each([
    ["backend exploded", "SCREENSHOT_CAPTURE_FAILED"],
    [SCREENSHOT_CAPTURE_CANCELLED_REASON, "SCREENSHOT_CAPTURE_CANCELLED"],
    [SCREENSHOT_CAPTURE_SUPERSEDED_REASON, "SCREENSHOT_CAPTURE_SUPERSEDED"],
    ["capture cancelled: backend", "SCREENSHOT_CAPTURE_FAILED"],
    ["ENOENT during capture", "SCREENSHOT_CAPTURE_FAILED"],
  ])("stored reason %s becomes %s without prose guessing", async (reason, code) => {
    const { observationId } = await observe();
    store.beginObservation(deviceA.deviceId, observationId);
    store.endObservation(deviceA.deviceId, observationId, reason);
    const body = failure(
      await read(buildObservationScreenshotUri(deviceA.deviceId, observationId)),
      code,
      {
        deviceId: deviceA.deviceId,
        observationId,
      },
    );
    expect(body.error).toBe(
      `No screenshot available for observation id ${observationId}: ${reason}`,
    );
  });

  test("observation without a screenshot is not captured", async () => {
    const { observationId } = await observe();
    const body = failure(
      await read(buildObservationScreenshotUri(deviceA.deviceId, observationId)),
      "SCREENSHOT_NOT_CAPTURED",
      {
        deviceId: deviceA.deviceId,
        observationId,
      },
    );
    expect(body.error).toBe(
      "No screenshot available. Call the 'observe' tool again to capture a screenshot.",
    );
  });

  test.each([
    ["ENOENT", "SCREENSHOT_FILE_UNAVAILABLE"],
    ["ENOTDIR", "SCREENSHOT_FILE_UNAVAILABLE"],
    ["EACCES", "SCREENSHOT_ACCESS_DENIED"],
    ["EPERM", "SCREENSHOT_ACCESS_DENIED"],
    ["EIO", "SCREENSHOT_READ_FAILED"],
    ["", "SCREENSHOT_READ_FAILED"],
  ])("retained file read errno %s becomes %s", async (errno, code) => {
    const { observationId } = await observe();
    store.updateForObservation(deviceA.deviceId, observationId, "/fake/mismatch.webp");
    const error = Object.assign(
      new Error("ENOENT EACCES misleading prose"),
      errno ? { code: errno } : {},
    );
    useScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async () => {
        throw error;
      },
    });
    const body = failure(
      await read(buildObservationScreenshotUri(deviceA.deviceId, observationId)),
      code,
      {
        deviceId: deviceA.deviceId,
        observationId,
      },
    );
    expect(body.error).toBe(
      `Failed to retrieve screenshot for observation id ${observationId}: Error: ENOENT EACCES misleading prose`,
    );
  });

  test.each(images)(
    "immutable success preserves $mimeType bytes despite extension mismatch",
    async (fixture) => {
      const { observationId } = await observe();
      store.updateForObservation(deviceA.deviceId, observationId, "/fake/mismatch.png");
      useScreenshotFileSystem({
        stat: async () => ({ isFile: () => true }),
        readFile: async () => fixture.bytes,
      });
      image(await read(buildObservationScreenshotUri(deviceA.deviceId, observationId)), fixture);
    },
  );

  test("device A failure and success never expose device B image", async () => {
    const a = await observe(deviceA);
    const b = await observe(deviceB);
    const otherBytes = Buffer.from("other device");
    store.updateForObservation(deviceB.deviceId, b.observationId, "/fake/b.png");
    useScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async (path) => (path === "/fake/b.png" ? otherBytes : images[0].bytes),
    });
    const uri = buildObservationScreenshotUri(deviceA.deviceId, a.observationId);
    const missing = await read(uri);
    expect(missing.blob).toBeUndefined();
    expect(missing.text).not.toContain(deviceB.deviceId);
    store.updateForObservation(deviceA.deviceId, a.observationId, "/fake/a.png");
    image(await read(uri));
    expect((await read(uri)).blob).not.toBe(otherBytes.toString("base64"));
  });

  test("host byte reader forwards code and retryability with unchanged error", async () => {
    const uri = buildObservationScreenshotUri(deviceA.deviceId, "unknown");
    const content = await read(uri);
    const body: FailureBody = JSON.parse(content.text!);
    expect(await readObservationScreenshotBytes(uri, deps)).toEqual({
      error: body.error,
      code: "OBSERVATION_NOT_RETAINED",
      retryable: false,
    });
  });

  test.each([RESOURCE_URIS.LATEST_OBSERVATION, RESOURCE_URIS.LATEST_SCREENSHOT])(
    "%s without observation is unavailable",
    async (uri) => {
      failure(await read(uri), "OBSERVATION_NOT_AVAILABLE");
    },
  );

  test.each([
    ["backend failed", "SCREENSHOT_CAPTURE_FAILED"],
    [SCREENSHOT_CAPTURE_CANCELLED_REASON, "SCREENSHOT_CAPTURE_CANCELLED"],
    [SCREENSHOT_CAPTURE_SUPERSEDED_REASON, "SCREENSHOT_CAPTURE_SUPERSEDED"],
    ["", "SCREENSHOT_NOT_CAPTURED"],
  ])("latest screenshot reason %s is %s without a consumer blob", async (reason, code) => {
    await observe();
    store.update(deviceA.deviceId, undefined, reason || undefined);
    failure(await read(RESOURCE_URIS.LATEST_SCREENSHOT), code, { deviceId: deviceA.deviceId });
  });

  test.each([
    ["ENOENT", "SCREENSHOT_FILE_UNAVAILABLE"],
    ["ENOTDIR", "SCREENSHOT_FILE_UNAVAILABLE"],
    ["EACCES", "SCREENSHOT_ACCESS_DENIED"],
    ["EPERM", "SCREENSHOT_ACCESS_DENIED"],
    ["EIO", "SCREENSHOT_READ_FAILED"],
  ])("latest screenshot stat errno %s is %s without a consumer blob", async (errno, code) => {
    await observe();
    store.update(deviceA.deviceId, "/fake/unavailable.png");
    useScreenshotFileSystem({
      stat: async () => {
        throw Object.assign(new Error("stat failed"), { code: errno });
      },
      readFile: async () => images[0].bytes,
    });
    failure(await read(RESOURCE_URIS.LATEST_SCREENSHOT), code, { deviceId: deviceA.deviceId });
    expect(timer.getPendingTimeouts()).toEqual([]);
    expect(timer.now()).toBe(0);
  });

  test("latest screenshot non-file is unavailable", async () => {
    await observe();
    store.update(deviceA.deviceId, "/fake/directory");
    useScreenshotFileSystem({
      stat: async () => ({ isFile: () => false }),
      readFile: async () => {
        throw new Error("Must not read a directory");
      },
    });
    failure(await read(RESOURCE_URIS.LATEST_SCREENSHOT), "SCREENSHOT_FILE_UNAVAILABLE", {
      deviceId: deviceA.deviceId,
    });
  });

  test("latest screenshot waits for a pending job to replace a pruned path", async () => {
    await observe();
    store.update(deviceA.deviceId, "/fake/pruned.png");
    const statPaths: string[] = [];
    const readPaths: string[] = [];
    useScreenshotFileSystem({
      stat: async (path) => {
        statPaths.push(path);
        if (path === "/fake/pruned.png") {
          throw Object.assign(new Error("pruned screenshot"), { code: "ENOENT" });
        }
        return { isFile: () => true };
      },
      readFile: async (path) => {
        readPaths.push(path);
        return images[1].bytes;
      },
    });
    const gate = Promise.withResolvers<void>();
    const job = ScreenshotJobTracker.startJob(deviceA.deviceId, async () => {
      await gate.promise;
      store.update(deviceA.deviceId, "/fake/new.jpg");
      return { success: true, path: "/fake/new.jpg" };
    });
    let settled = false;
    const pending = read(RESOURCE_URIS.LATEST_SCREENSHOT).then((content) => {
      settled = true;
      return content;
    });
    try {
      await drainMicrotasks();
      expect(statPaths).toEqual(["/fake/pruned.png"]);
      expect(readPaths).toEqual([]);
      expect(settled).toBe(false);
      expect(timer.getPendingTimeouts()).toEqual([3000]);
      gate.resolve();
      image(await pending, images[1]);
      expect(statPaths).toEqual(["/fake/pruned.png", "/fake/new.jpg"]);
      expect(readPaths).toEqual(["/fake/new.jpg"]);
      expect(timer.getPendingTimeouts()).toEqual([]);
    } finally {
      gate.resolve();
      await job.promise;
    }
  });

  test("latest pruned screenshot still pending at 3000ms reports not ready", async () => {
    await observe();
    store.update(deviceA.deviceId, "/fake/pruned.png");
    let statCalls = 0;
    useScreenshotFileSystem({
      stat: async () => {
        statCalls++;
        throw Object.assign(new Error("pruned screenshot"), { code: "ENOENT" });
      },
      readFile: async () => {
        throw new Error("Must not read a pruned path");
      },
    });
    ScreenshotJobTracker.startJob(deviceA.deviceId, async () => new Promise(() => {}));
    let settled = false;
    const pending = read(RESOURCE_URIS.LATEST_SCREENSHOT).then((content) => {
      settled = true;
      return content;
    });
    await drainMicrotasks();
    timer.advanceTime(2999);
    await drainMicrotasks();
    expect(settled).toBe(false);
    expect(statCalls).toBe(1);
    timer.advanceTime(1);
    const body = failure(await pending, "SCREENSHOT_NOT_READY", { deviceId: deviceA.deviceId });
    expect(body.error).toContain("not ready yet");
    expect(body.error).not.toContain("observe");
    expect(statCalls).toBe(2);
  });

  test("latest screenshot still pending after 3000ms is retryable without a blob", async () => {
    await observe();
    ScreenshotJobTracker.startJob(deviceA.deviceId, async () => new Promise(() => {}));
    const pending = read(RESOURCE_URIS.LATEST_SCREENSHOT);
    await drainMicrotasks();
    timer.advanceTime(3000);
    const body = failure(await pending, "SCREENSHOT_NOT_READY", { deviceId: deviceA.deviceId });
    expect(body.error).toContain("not ready yet");
    expect(body.error).not.toContain("observe");
  });

  test.each(["job", "observation"])(
    "latest screenshot pending in %s ignores a previous capture error",
    async (source) => {
      const { observationId } = await observe();
      store.update(deviceA.deviceId, undefined, "previous capture failed");
      if (source === "job") {
        ScreenshotJobTracker.startJob(deviceA.deviceId, async () => new Promise(() => {}));
      } else {
        store.beginObservation(deviceA.deviceId, observationId);
      }
      const pending = read(RESOURCE_URIS.LATEST_SCREENSHOT);
      await drainMicrotasks();
      timer.advanceTime(3000);
      const body = failure(await pending, "SCREENSHOT_NOT_READY", { deviceId: deviceA.deviceId });
      expect(body.error).toBe(
        "Screenshot for the latest observation is not ready yet. Call the resource again after the capture completes.",
      );
      expect(body.error).not.toContain("observe");
      expect(body.error).not.toContain("previous capture failed");
    },
  );

  test.each(images)("latest screenshot consumer receives $mimeType blob", async (fixture) => {
    await observe();
    store.update(deviceA.deviceId, "/fake/latest.png");
    useScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async () => fixture.bytes,
    });
    const content = await read(RESOURCE_URIS.LATEST_SCREENSHOT);
    image(content, fixture);
    expect([content].find((item) => item.blob?.trim())).toBe(content);
  });

  test.each(sessionUris)("foreign caller of %s sees only session identity", async (uri) => {
    let resolved = false;
    useSessionScreenshotResourceDependencies({
      resolveActiveSession: () => {
        resolved = true;
        return { sessionUuid, device: deviceA };
      },
      createScreenshotService: () => {
        throw new Error("Must not capture");
      },
    });
    const body = failure(
      await read(uri, { sessionUuid: "foreign", ownsSession: () => false }),
      "SESSION_NOT_BOUND",
      { sessionUuid },
    );
    expect(body.error).toBe("This resource can only be read by its bound device session.");
    expect(resolved).toBe(false);
    expect(body).not.toHaveProperty("deviceId");
  });

  test.each(sessionUris)("inactive session at %s retains the session id", async (uri) => {
    resolveSession(false);
    failure(await read(uri, { sessionUuid }), "SESSION_NOT_ACTIVE", { sessionUuid });
  });

  test.each(sessionUris)("session at %s without observation is unavailable", async (uri) => {
    resolveSession();
    failure(await read(uri, { sessionUuid }), "OBSERVATION_NOT_AVAILABLE", {
      deviceId: deviceA.deviceId,
      sessionUuid,
    });
  });

  test("owning session still reads cached observation and screenshot", async () => {
    await observe();
    store.update(deviceA.deviceId, "/fake/session.png");
    resolveSession();
    const context = { sessionUuid: "foreign", ownsSession: () => true };
    expect(JSON.parse((await read(sessionUris[0], context)).text!).viewHierarchy.packageName).toBe(
      "A",
    );
    image(await read(sessionUris[1], context));
  });

  test("fresh-session failure retains its exact existing shape", async () => {
    resolveSession(false);
    const content = await read(`automobile:device-session/${sessionUuid}/screenshot`, {
      sessionUuid,
    });
    expect(content.mimeType).toBe("application/json");
    expect(content.blob).toBeUndefined();
    expect(JSON.parse(content.text!)).toEqual({
      code: "SESSION_NOT_ACTIVE",
      retryable: false,
      error: `No active device session found for sessionUuid ${sessionUuid}.`,
    });
    expect(Object.keys(JSON.parse(content.text!))).toEqual(["code", "retryable", "error"]);
  });
  test("latest observation generic catch is typed and preserves its sentence", async () => {
    setObserveCacheStore(new UnreadableObservationCache(timer));
    const body = failure(await read(RESOURCE_URIS.LATEST_OBSERVATION), "OBSERVATION_READ_FAILED");
    expect(body.error).toBe("Failed to retrieve observation: Error: observation cache failed");
  });

  test("latest screenshot generic catch has no consumer blob before device resolution", async () => {
    setObserveCacheStore(new UnreadableObservationCache(timer));
    failure(await read(RESOURCE_URIS.LATEST_SCREENSHOT), "SCREENSHOT_READ_FAILED");
  });

  test("session observation generic catch keeps resolved identities", async () => {
    resolveSession();
    setObserveCacheStore(new UnreadableObservationCache(timer));
    const body = failure(await read(sessionUris[0], { sessionUuid }), "OBSERVATION_READ_FAILED", {
      deviceId: deviceA.deviceId,
      sessionUuid,
    });
    expect(body.error).toBe(
      `Failed to retrieve observation for sessionUuid ${sessionUuid}: Error: observation cache failed`,
    );
  });

  test.each([
    ["backend failed", "SCREENSHOT_CAPTURE_FAILED"],
    [SCREENSHOT_CAPTURE_CANCELLED_REASON, "SCREENSHOT_CAPTURE_CANCELLED"],
    [SCREENSHOT_CAPTURE_SUPERSEDED_REASON, "SCREENSHOT_CAPTURE_SUPERSEDED"],
    ["", "SCREENSHOT_NOT_CAPTURED"],
  ])("session screenshot reason %s becomes %s", async (reason, code) => {
    await observe();
    resolveSession();
    store.update(deviceA.deviceId, undefined, reason || undefined);
    failure(await read(sessionUris[1], { sessionUuid }), code, {
      deviceId: deviceA.deviceId,
      sessionUuid,
    });
  });

  test.each(["job", "observation"])(
    "session screenshot pending in %s has a retry remedy",
    async (source) => {
      const { observationId } = await observe();
      resolveSession();
      store.update(deviceA.deviceId, undefined, "previous capture failed");
      if (source === "job") {
        ScreenshotJobTracker.startJob(deviceA.deviceId, async () => new Promise(() => {}));
      } else {
        store.beginObservation(deviceA.deviceId, observationId);
      }
      const body = failure(await read(sessionUris[1], { sessionUuid }), "SCREENSHOT_NOT_READY", {
        deviceId: deviceA.deviceId,
        sessionUuid,
      });
      expect(body.error).toBe(
        `Screenshot for sessionUuid ${sessionUuid} is not ready yet. Call the resource again after the capture completes.`,
      );
      expect(body.error).not.toContain("observe");
      expect(body.error).not.toContain("previous capture failed");
      expect(timer.getPendingTimeouts()).toEqual([]);
      expect(timer.now()).toBe(0);
    },
  );

  test.each([
    ["ENOENT", "SCREENSHOT_FILE_UNAVAILABLE"],
    ["EACCES", "SCREENSHOT_ACCESS_DENIED"],
    ["", "SCREENSHOT_READ_FAILED"],
  ])("latest and session file-read errno %s becomes %s", async (errno, code) => {
    await observe();
    resolveSession();
    store.update(deviceA.deviceId, "/fake/read.png");
    useScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async () => {
        throw Object.assign(new Error("read failed"), errno ? { code: errno } : {});
      },
    });
    failure(await read(RESOURCE_URIS.LATEST_SCREENSHOT), code, { deviceId: deviceA.deviceId });
    failure(await read(sessionUris[1], { sessionUuid }), code, {
      deviceId: deviceA.deviceId,
      sessionUuid,
    });
  });

  test("immutable and session retained paths must be files", async () => {
    const { observationId } = await observe();
    resolveSession();
    store.update(deviceA.deviceId, "/fake/directory");
    store.updateForObservation(deviceA.deviceId, observationId, "/fake/directory");
    useScreenshotFileSystem({
      stat: async () => ({ isFile: () => false }),
      readFile: async () => {
        throw new Error("Must not read a directory");
      },
    });
    failure(
      await read(buildObservationScreenshotUri(deviceA.deviceId, observationId)),
      "SCREENSHOT_FILE_UNAVAILABLE",
      { deviceId: deviceA.deviceId, observationId },
    );
    failure(await read(sessionUris[1], { sessionUuid }), "SCREENSHOT_FILE_UNAVAILABLE", {
      deviceId: deviceA.deviceId,
      sessionUuid,
    });
  });

  test("observation replaced while waiting returns not retained", async () => {
    const { observationId } = await observe();
    store.beginObservation(deviceA.deviceId, observationId);
    const pending = read(buildObservationScreenshotUri(deviceA.deviceId, observationId));
    await Promise.resolve();
    const newer = await observe();
    store.updateForObservation(deviceA.deviceId, newer.observationId, "/fake/newer.png");
    store.endObservation(deviceA.deviceId, observationId, SCREENSHOT_CAPTURE_SUPERSEDED_REASON);
    failure(await pending, "OBSERVATION_NOT_RETAINED", {
      deviceId: deviceA.deviceId,
      observationId,
    });
  });

  test("observation replaced during file read never returns either image", async () => {
    const { observationId } = await observe();
    store.updateForObservation(deviceA.deviceId, observationId, "/fake/old.png");
    useScreenshotFileSystem({
      stat: async () => ({ isFile: () => true }),
      readFile: async () => {
        const newer = await observe();
        store.updateForObservation(deviceA.deviceId, newer.observationId, "/fake/newer.png");
        return images[0].bytes;
      },
    });
    failure(
      await read(buildObservationScreenshotUri(deviceA.deviceId, observationId)),
      "OBSERVATION_NOT_RETAINED",
      { deviceId: deviceA.deviceId, observationId },
    );
  });

  test("host byte reader forwards pending retryability", async () => {
    const { observationId } = await observe();
    store.beginObservation(deviceA.deviceId, observationId);
    const pending = readObservationScreenshotBytes(
      buildObservationScreenshotUri(deviceA.deviceId, observationId),
      deps,
    );
    await Promise.resolve();
    timer.advanceTime(10_000);
    expect(await pending).toEqual({
      code: "SCREENSHOT_NOT_READY",
      retryable: true,
      error: `Screenshot for observation id ${observationId} is not ready yet. Call the resource again after the capture completes.`,
    });
  });

  test("fresh capture failure retains retryable true and no identifying fields", async () => {
    useSessionScreenshotResourceDependencies({
      resolveActiveSession: () => ({ sessionUuid, device: deviceA }),
      createScreenshotService: () => ({
        execute: async () => ({ success: false, error: "backend failed" }),
        generateScreenshotPath: () => "/fake/fresh.png",
        getActivityHash: async () => "hash",
        startTrackedCapture: () => ({
          jobId: "fake-job",
          signal: new AbortController().signal,
          promise: Promise.resolve({ success: false, error: "backend failed" }),
        }),
      }),
    });
    const content = await read(`automobile:device-session/${sessionUuid}/screenshot`, {
      sessionUuid,
    });
    expect(content.mimeType).toBe("application/json");
    expect(content.blob).toBeUndefined();
    expect(content.text).toBe(
      JSON.stringify(
        { code: "SCREENSHOT_CAPTURE_FAILED", retryable: true, error: "backend failed" },
        null,
        2,
      ),
    );
  });
});
