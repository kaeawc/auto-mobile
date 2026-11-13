import { describe, expect, test } from "bun:test";
import { TapAtCoordinate } from "../../../src/features/action/TapAtCoordinate";
import type { IosCoordinateTapClient } from "../../../src/features/action/coordinateTapDispatch";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAndroidXrDetector } from "../../fakes/FakeAndroidXrDetector";
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { observation, setFakeTapAtWindow } from "../../helpers/tapAtCoordinate";

type TapReply = Awaited<ReturnType<IosCoordinateTapClient["requestTapCoordinates"]>>;

function splitViewObservation(detail: string): ObserveResult {
  return {
    ...observation(1024, 768, "frame", 0, {
      class: "XCUIElementTypeApplication",
      "view-id": "root",
      bounds: { left: 0, top: 0, right: 1024, bottom: 768 },
      node: [
        { class: "XCUIElementTypeNavigationBar", text: "Library", "view-id": "nav-bar" },
        {
          class: "XCUIElementTypeCell",
          text: "Recent",
          "view-id": "sidebar-recent",
          bounds: { left: 0, top: 100, right: 300, bottom: 150 },
        },
        {
          class: "XCUIElementTypeStaticText",
          text: detail,
          "view-id": "detail-title",
          bounds: { left: 320, top: 100, right: 900, bottom: 200 },
        },
      ],
    }),
    display: { key: "main", role: "unknown", posture: "unknown", generation: 0 },
    screenIdentity: {
      platform: "ios",
      source: "heuristic",
      confidence: "medium",
      key: "com.example.library|Library",
      components: { bundleId: "com.example.library", navigationTitle: "Library" },
    },
  };
}

function createTapAt(
  before: ObserveResult,
  after: ObserveResult,
  reply: TapReply = { success: true },
  platform: BootedDevice["platform"] = "ios",
) {
  const device: BootedDevice = {
    name: "split view",
    deviceId: "tap-at-effect",
    platform,
    displays: {
      panels: [{ key: "main", role: "unknown", sizePx: { width: 1024, height: 768 } }],
      postures: [],
    },
  };
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveSequence([before, after]);
  const requests: string[] = [];
  const iosClient: IosCoordinateTapClient = {
    requestTapCoordinates: async () => {
      requests.push("tap");
      return reply;
    },
    requestDoubleTapCoordinates: async () => {
      requests.push("doubleTap");
      return reply;
    },
  };
  const tapAt = new TapAtCoordinate(device, new FakeAdbExecutor(), {
    timer,
    iosClient,
    androidClient: { requestTapCoordinates: async () => ({ success: true }) },
    dispatchAndroidCoordinateTap: async () => {},
    xrDetector: new FakeAndroidXrDetector(false),
    displayTransitions: new FakeDisplayTransitionReader(),
    lastRenderedObservation: () => before,
    invalidateIosCache: () => {},
  });
  setFakeTapAtWindow(tapAt);
  tapAt.observeScreen = observeScreen;
  return { tapAt, requests, timer };
}

describe.each([undefined, "main"])("tapAt iOS evidence (display=%s)", (display) => {
  test.each([true, false])(
    "reports hierarchy change=%s with the same screen identity",
    async (changed) => {
      const before = splitViewObservation("All documents");
      const after = splitViewObservation(changed ? "Recent documents" : "All documents");
      const { tapAt, timer } = createTapAt(before, after);
      expect(before.screenIdentity).toEqual(after.screenIdentity);
      const start = timer.now();
      const result = await tapAt.execute({ x: 150, y: 125, display });
      expect(result.success).toBe(true);
      expect(result).toHaveProperty("effect", {
        screenChanged: changed,
        basis: changed ? "viewHierarchy changed" : "screenIdentity unchanged",
      });
      expect(timer.getPendingSleepCount()).toBe(0);
      expect(timer.now() - start).toBe(timer.getSleepHistory().reduce((sum, ms) => sum + ms, 0));
    },
  );

  test("reports the unchanged hierarchy basis without screen identity", async () => {
    const before = splitViewObservation("All documents");
    const after = splitViewObservation("All documents");
    delete before.screenIdentity;
    delete after.screenIdentity;
    const { tapAt } = createTapAt(before, after);
    const result = await tapAt.execute({ x: 150, y: 125, display });
    expect(result.success).toBe(true);
    expect(result).toHaveProperty("effect", {
      screenChanged: false,
      basis: "viewHierarchy unchanged",
    });
  });

  for (const action of ["tap", "doubleTap", "longPress"] as const) {
    test.each(["xcuiCoordinate", "displayTargetedRecord", undefined] as const)(
      `${action} reports only the runner's route=%s`,
      async (route) => {
        const before = splitViewObservation("All documents");
        const { tapAt, requests } = createTapAt(before, before, {
          success: true,
          ...(route ? { tapDiagnostics: { route } } : {}),
        });
        const result = await tapAt.execute({ x: 150, y: 125, display, action });
        expect(result.success).toBe(true);
        if (route === undefined) {
          expect(result).not.toHaveProperty("dispatchRoute");
        } else {
          expect(result).toHaveProperty("dispatchRoute", route);
        }
        expect(requests).toEqual([action === "doubleTap" ? "doubleTap" : "tap"]);
      },
    );
  }
});

test("Android tapAt does not add effect or dispatchRoute", async () => {
  const before = splitViewObservation("All documents");
  const after = splitViewObservation("Recent documents");
  const { tapAt } = createTapAt(before, after, { success: true }, "android");
  const result = await tapAt.execute({ x: 150, y: 125 });
  expect(result.success).toBe(true);
  expect(result).not.toHaveProperty("effect");
  expect(result).not.toHaveProperty("dispatchRoute");
});
