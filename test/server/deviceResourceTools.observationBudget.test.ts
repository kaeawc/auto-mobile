import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DefaultDeviceResourceObserver } from "../../src/utils/deviceResourceObserver";
import {
  deviceReadinessLockKey,
  getDeviceAcquisitionReadiness,
} from "../../src/utils/deviceReadinessLock";
import {
  androidDeviceResourceCatalog,
  androidResourceSettings,
} from "../../src/utils/androidDeviceResourceCatalog";
import { logger } from "../../src/utils/logger";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { FakeDeviceResourceController } from "../fakes/FakeDeviceResourceController";
import { FakeDeviceResourceObserver } from "../fakes/FakeDeviceResourceObserver";
import { ResourceAdb, bootId } from "../fakes/FakeAndroidResourceAdb";
import { FakeTimer } from "../fakes/FakeTimer";

isolateToolRegistry();
const device = { platform: "android" as const, deviceId: "emulator-5580", name: "resource-test" };
let controller: FakeDeviceResourceController;
let observer: FakeDeviceResourceObserver;
let timer: FakeTimer;
const handler = () => ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!;
beforeEach(() => {
  controller = new FakeDeviceResourceController();
  controller.result.restore = {
    deviceId: device.deviceId,
    bootId,
    userId: 0,
    entries: [
      { resource: "animations", kind: "global", target: "animator_duration_scale", value: "1" },
    ],
  };
  observer = new FakeDeviceResourceObserver();
  timer = new FakeTimer();
  setDeviceToolsDependencies({
    timer,
    deviceResourceControllerFactory: () => controller,
    deviceResourceObserverFactory: () => observer,
  });
  registerDeviceTools();
});
afterEach(() => resetDeviceToolsDependencies());

test("observation starts after the acquisition marker releases, with half the post-mutation time", async () => {
  controller.onRequest = async () => {
    expect(
      getDeviceAcquisitionReadiness(deviceReadinessLockKey(device.platform, device.deviceId)),
    ).toBeDefined();
    timer.advanceTime(200);
  };
  let markerAtObservation: ReturnType<typeof getDeviceAcquisitionReadiness>;
  observer.onRequest = async () => {
    markerAtObservation = getDeviceAcquisitionReadiness(
      deviceReadinessLockKey(device.platform, device.deviceId),
    );
  };
  await handler()(device, { resources: { animations: "disabled" }, timeoutMs: 1000 });
  expect(markerAtObservation).toBeUndefined();
  expect(observer.requests).toHaveLength(1);
  expect(observer.requests[0]!.deadlineMs).toBe(600);
  expect(observer.requests[0]!.signal).toBe(controller.requests[0]!.signal);
});

test("exhausted observation preserves mutation and restore receipt with a complete partial snapshot", async () => {
  const adb = new ResourceAdb();
  adb.packages.set("com.google.android.gms", "1");
  adb.onCommand = () => {
    if (adb.commands.at(-1)?.[0] === "dumpsys") {
      timer.advanceTime(500);
    }
  };
  setDeviceToolsDependencies({
    deviceResourceObserverFactory: () =>
      new DefaultDeviceResourceObserver({ adbFactory: { create: () => adb }, timer }),
  });
  const warning = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const response = await handler()(device, {
      resources: { animations: "disabled" },
      timeoutMs: 1000,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.restore).toEqual(controller.result.restore);
    expect(result.observed.resources.animations.state).toBe("unknown");
    expect(result.observed.resources.backup.state).toBe("unknown");
    expect(Object.keys(result.observed.resources)).toEqual(
      expect.arrayContaining([
        ...Object.keys(androidDeviceResourceCatalog),
        ...Object.keys(androidResourceSettings),
        "backup",
        "wallpaperRendering",
        "widgets",
        "liveActivities",
        "backgroundSync",
        "searchIndexing",
      ]),
    );
    expect(result.observationContradictions).toBeUndefined();
    expect(response.isError).toBeUndefined();
    expect(timer.now()).toBe(500);
    expect(adb.commands.some((args) => args[0] === "settings")).toBe(false);
  } finally {
    warning.mockRestore();
  }
});

test("observation abort carries the completed receipt on the original AbortError", async () => {
  const abort = new AbortController();
  const reason = Object.assign(new DOMException("cancelled", "AbortError"), {
    deviceResourceResult: undefined as typeof controller.result | undefined,
  });
  observer.onRequest = async () => {
    abort.abort(reason);
  };
  await expect(
    handler()(
      device,
      { resources: { animations: "disabled" }, timeoutMs: 1000 },
      undefined,
      abort.signal,
    ),
  ).rejects.toBe(reason);
  expect(reason.name).toBe("AbortError");
  expect(reason.deviceResourceResult).toEqual({
    ...controller.result,
    requested: { animations: "disabled" },
  });
  expect(reason.deviceResourceResult?.restore).toBe(controller.result.restore);
});

test("abort before mutation completion does not acquire an observation result carrier", async () => {
  const abort = new AbortController();
  const reason = Object.assign(new DOMException("cancelled", "AbortError"), {
    deviceResourceResult: undefined as typeof controller.result | undefined,
  });
  controller.onRequest = async () => {
    abort.abort(reason);
    throw reason;
  };
  await expect(
    handler()(device, { resources: { animations: "disabled" } }, undefined, abort.signal),
  ).rejects.toBe(reason);
  expect(reason.deviceResourceResult).toBeUndefined();
  expect(observer.requests).toHaveLength(0);
});
