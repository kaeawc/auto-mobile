import { afterEach, describe, expect, test } from "bun:test";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { HierarchyCollector } from "../../../src/features/observe/collectors/HierarchyCollector";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { ObservedAndroidDisplayCache } from "../../../src/features/observe/ObservationDisplay";
import { DisplaySelectionError } from "../../../src/features/observe/DisplaySelection";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import type { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";

/**
 * Issue #9981: `observe { raw: true }` attaches the unfiltered tree after the
 * filtered read. That companion must come from the display the observation
 * describes, not from CtrlProxy's default display.
 */
const device: BootedDevice = {
  name: "Dual display",
  platform: "android",
  deviceId: "raw-display-test",
  displays: {
    panels: [
      { key: "cover", role: "cover", sizePx: { width: 100, height: 100 } },
      { key: "external", role: "external", sizePx: { width: 200, height: 200 } },
    ],
    postures: ["closed"],
  },
};

const bothDisplays =
  'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}';
const coverOnly = 'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}';

type RawClient = Pick<AndroidCtrlProxyClient, "requestHierarchySync" | "invalidateCache">;
type RawRequest = Parameters<RawClient["requestHierarchySync"]>;

function rawClientRecorder() {
  const requests: RawRequest[] = [];
  let invalidations = 0;
  const client: RawClient = {
    requestHierarchySync: async (...args) => {
      requests.push(args);
      return {
        hierarchy: { updatedAt: 0, packageName: "com.example", hierarchy: { text: "raw" } },
      };
    },
    invalidateCache: () => {
      invalidations++;
    },
  };
  return { client, requests, invalidations: () => invalidations };
}

function buildScreen(options: { display?: string; displays: string }) {
  const timer = new FakeTimer();
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("cmd display get-displays", { stdout: options.displays, stderr: "" });
  const adbFactory = new FakeAdbClientFactory(adb);
  const recorder = rawClientRecorder();
  const capture = new FakeHierarchyCapture(() => ({
    hierarchy: {},
    displayId: options.display === "external" ? 2 : 0,
  }));
  const screen = new RealObserveScreen(
    device,
    adbFactory,
    {
      display: options.display,
      hierarchyCapture: capture,
      cacheStore: new FakeObserveCacheStore(timer),
      hierarchyCollector: new HierarchyCollector({
        device,
        viewHierarchy: new FakeViewHierarchy(),
        adb,
        adbFactory,
        timer,
        androidRawClient: () => recorder.client,
      }),
    },
    timer,
  );
  return { screen, capture, ...recorder };
}

const primary = (): ObserveResult => ({
  updatedAt: 0,
  screenSize: { width: 0, height: 0 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  display: { key: "cover", role: "cover", posture: "closed", generation: 0 },
  viewHierarchy: { hierarchy: {} },
});

describe("raw hierarchy display routing (#9981)", () => {
  afterEach(() => {
    ObservedAndroidDisplayCache.release(device.deviceId);
    displayTransitions.reset(device.deviceId);
    resetObserveCacheStore();
  });

  test("an explicit panel requests the raw tree with the same logical display id as the filtered read", async () => {
    ObservedAndroidDisplayCache.release(device.deviceId);
    const { screen, capture, requests, invalidations } = buildScreen({
      display: "external",
      displays: bothDisplays,
    });

    const result = await screen.execute({
      skipScreenshot: true,
      skipBackStack: true,
      skipPerformanceAudit: true,
      skipRecompositionTracking: true,
      skipAccessibilityAudit: true,
    });
    await screen.appendRawViewHierarchy(result);

    expect(capture.requests[0]?.displayId).toBe(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.[1]).toBe(true);
    expect(requests[0]?.[5]).toBe(2);
    expect(result.rawViewHierarchy?.json).toContain("raw");
    // A non-default display answers its caller only (#10106); the shared cache was never written.
    expect(invalidations()).toBe(0);
  });

  test("a display pinned through the screen's display argument is routed the same way", async () => {
    ObservedAndroidDisplayCache.release(device.deviceId);
    // The session display pin reaches RealObserveScreen as its `display` (createScreen(device, display)).
    const { screen, requests } = buildScreen({ display: "cover", displays: bothDisplays });

    await screen.appendRawViewHierarchy(primary());

    expect(requests).toHaveLength(1);
    expect(requests[0]?.[5]).toBe(0);
  });

  test("the default display sends the unchanged request without a display id", async () => {
    const { screen, requests, invalidations } = buildScreen({ displays: bothDisplays });
    const signal = new AbortController().signal;

    await screen.appendRawViewHierarchy(primary(), signal);
    // The unfiltered default-display tree was cached by the read, so it is dropped again.
    expect(invalidations()).toBe(1);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.[1]).toBe(true);
    expect(requests[0]?.[2]).toBe(signal);
    expect(requests[0]?.[3]).toBeUndefined();
    expect(requests[0]?.[4]).toBeUndefined();
    expect(requests[0]?.[5]).toBeUndefined();
  });

  test("a disconnected explicit panel is refused instead of reading another display", async () => {
    ObservedAndroidDisplayCache.release(device.deviceId);
    const { screen, requests } = buildScreen({ display: "external", displays: coverOnly });

    await expect(screen.appendRawViewHierarchy(primary())).rejects.toBeInstanceOf(
      DisplaySelectionError,
    );
    expect(requests).toEqual([]);
  });
});
