import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PinchOn } from "../../../src/features/action/PinchOn";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import type { BootedDevice, ElementBounds, ObserveResult } from "../../../src/models";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";

// Measured bounds from #9186: element [0,-361,855,1456], screen 402x874.
// Unclipped centerX 428 / distanceStart 513 did nothing; expected centre (201,437).
const measuredBounds = { left: 0, top: -361, right: 855, bottom: 1456 };
const screenBounds = { left: 0, top: 0, right: 402, bottom: 874 };

type Gesture = {
  centerX: number;
  centerY: number;
  distanceStart: number;
  distanceEnd: number;
  rotationDegrees: number;
};

function expectFingersInside(gesture: Gesture, bounds: ElementBounds): void {
  const radians = (gesture.rotationDegrees * Math.PI) / 180;
  // Each finger travels on a line segment: endpoints imply containment throughout.
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const distance =
      gesture.distanceStart + fraction * (gesture.distanceEnd - gesture.distanceStart);
    for (const sign of [-1, 1]) {
      const x = gesture.centerX + ((sign * distance) / 2) * Math.cos(radians);
      const y = gesture.centerY + ((sign * distance) / 2) * Math.sin(radians);
      expect(x).toBeGreaterThanOrEqual(bounds.left);
      expect(x).toBeLessThanOrEqual(bounds.right);
      expect(y).toBeGreaterThanOrEqual(bounds.top);
      expect(y).toBeLessThanOrEqual(bounds.bottom);
    }
  }
}

test("g exports the existing distance limits and their derived visible minimum", async () => {
  const constants = await import("../../../src/features/action/PinchOn");
  expect(constants).toHaveProperty("PINCH_MIN_DISTANCE_PX", 10);
  expect(constants).toHaveProperty("PINCH_MAX_DISTANCE_RATIO", 0.9);
  expect(constants).toHaveProperty("PINCH_MIN_VISIBLE_DIMENSION_PX", 12);
});

for (const platform of ["android", "ios"] as const) {
  describe(`PinchOn visible bounds (${platform})`, () => {
    let pinch: PinchOn;
    let observe: FakeObserveScreen;
    let android: FakeCtrlProxy;
    let ios: FakeIOSCtrlProxy;
    let timer: FakeTimer;
    const restores: Array<() => void> = [];

    const setTarget = (
      bounds: ElementBounds,
      insets = { top: 0, right: 0, bottom: 0, left: 0 },
      size = { width: 402, height: 874 },
    ) => {
      const screen: ObserveResult = {
        updatedAt: timer.now(),
        screenSize: size,
        systemInsets: insets,
        viewHierarchy: {
          hierarchy: {
            node: [
              {
                $: {
                  "resource-id": "container-id",
                  text: "Example Domain",
                  bounds,
                  class: "android.widget.FrameLayout",
                  scrollable: true,
                },
              },
            ],
          },
          packageName: "com.test.app",
          updatedAt: timer.now(),
        },
      };
      observe.setObserveResult(screen);
    };

    beforeEach(() => {
      timer = new FakeTimer();
      timer.enableAutoAdvance();
      android = new FakeCtrlProxy(timer);
      ios = new FakeIOSCtrlProxy(timer);
      observe = new FakeObserveScreen();
      setTarget(measuredBounds);
      const device: BootedDevice = {
        deviceId: `pinch-visible-${platform}`,
        name: "Fake device",
        platform,
      };
      const window = new FakeWindow();
      window.configureCachedActiveWindow(null);
      window.configureActiveWindow({
        appId: "com.test.app",
        activityName: "MainActivity",
        layoutSeqSum: 123,
      });
      const androidSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
        android as unknown as AndroidCtrlProxyClient,
      );
      const iosSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        ios as unknown as IOSCtrlProxyClient,
      );
      const managerSpy = spyOn(AndroidCtrlProxyManager, "getInstance").mockReturnValue({
        isAvailable: async () => true,
      } as unknown as AndroidCtrlProxyManager);
      restores.push(
        () => androidSpy.mockRestore(),
        () => iosSpy.mockRestore(),
        () => managerSpy.mockRestore(),
      );
      pinch = new PinchOn(device, null, {
        timer,
        visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
        capture: new FakeHierarchyCapture(
          async () => (await observe.getMostRecentCachedObserveResult()).viewHierarchy!,
          platform,
        ),
      });
      Object.assign(pinch, {
        observeScreen: observe,
        awaitIdle: new FakeAwaitIdle(),
        window,
        adb: new FakeAdbExecutor(),
      });
    });

    afterEach(() => {
      for (const restore of restores.splice(0).reverse()) {
        restore();
      }
      timer.reset();
    });

    const history = () =>
      platform === "android" ? android.getPinchHistory() : ios.getPinchHistory();
    const rounded = (value: number) => (platform === "ios" ? Math.round(value) : value);

    for (const explicit of [true, false]) {
      for (const direction of ["in", "out"] as const) {
        test.each([0, 90, 45])(
          `a/b clips measured ${explicit ? "explicit" : "auto"} target, ${direction}, rotation %s`,
          async (rotationDegrees) => {
            const interaction = spyOn(pinch, "observedInteraction");
            restores.push(() => interaction.mockRestore());
            const result = await pinch.execute({
              direction,
              rotationDegrees,
              container: explicit ? { elementId: "container-id" } : undefined,
            });
            expect(result.success).toBe(true);
            expect(result.targetType).toBe("container");
            const [gesture] = history();
            expect(gesture).toMatchObject({
              centerX: 201,
              centerY: 437,
              distanceStart: rounded(402 * (direction === "in" ? 0.6 : 0.2)),
              distanceEnd: rounded(402 * (direction === "in" ? 0.2 : 0.6)),
            });
            expect(gesture.distanceStart).toBeLessThanOrEqual(0.9 * 402);
            expect(gesture.distanceEnd).toBeLessThanOrEqual(0.9 * 402);
            expectFingersInside(gesture, screenBounds);
            const geometry = {
              centerX: gesture.centerX,
              centerY: gesture.centerY,
              distanceStart: gesture.distanceStart,
              distanceEnd: gesture.distanceEnd,
            };
            expect(result).toMatchObject({
              ...geometry,
              scale: gesture.distanceEnd / gesture.distanceStart,
            });
            const toolArgs = interaction.mock.calls[0][1].predictionContext?.toolArgs;
            expect(toolArgs).toMatchObject(geometry);
            expect(toolArgs).not.toHaveProperty("scale");
            if (platform === "ios") {
              expect(Number.isInteger(gesture.distanceStart)).toBe(true);
              expect(Number.isInteger(gesture.distanceEnd)).toBe(true);
              expect(android.getPinchHistory()).toEqual([]);
            } else {
              expect(ios.getPinchHistory()).toEqual([]);
            }
          },
        );
      }
    }

    test.each([0, 90, 45])(
      "a/b caps requested distances and scale at rotation %s",
      async (rotationDegrees) => {
        const result = await pinch.execute({
          direction: "out",
          distanceStart: 1000,
          scale: 4,
          rotationDegrees,
        });
        expect(result.success).toBe(true);
        const [gesture] = history();
        expect(gesture).toMatchObject({
          centerX: 201,
          centerY: 437,
          distanceStart: rounded(0.9 * 402),
          distanceEnd: rounded(0.9 * 402),
        });
        expectFingersInside(gesture, screenBounds);
        expect(result.scale).toBe(1);
      },
    );

    test.each([
      ["top", { left: 0, top: -300, right: 402, bottom: 500 }, 201, 250, 402],
      ["right", { left: 200, top: 100, right: 700, bottom: 500 }, 301, 300, 202],
      ["left", { left: -300, top: 100, right: 202, bottom: 500 }, 101, 300, 202],
    ] as const)(
      "c clips only the %s edge",
      async (_edge, bounds, centerX, centerY, minDimension) => {
        setTarget(bounds);
        const result = await pinch.execute({
          direction: "in",
          container: { elementId: "container-id" },
          rotationDegrees: 45,
        });
        expect(result.success).toBe(true);
        const [gesture] = history();
        expect(gesture).toMatchObject({
          centerX,
          centerY,
          distanceStart: rounded(minDimension * 0.6),
          distanceEnd: rounded(minDimension * 0.2),
        });
        expectFingersInside(gesture, screenBounds);
      },
    );

    test.each([
      [
        "200x200 fixture",
        { left: 0, top: 0, right: 200, bottom: 200 },
        { width: 402, height: 874 },
        true,
        100,
        100,
        40,
        120,
      ],
      [
        "full-screen map",
        { left: 0, top: 0, right: 1000, bottom: 1500 },
        { width: 1000, height: 1500 },
        false,
        500,
        750,
        200,
        600,
      ],
      [
        "odd-sized container",
        { left: 0, top: 0, right: 393, bottom: 851 },
        { width: 402, height: 874 },
        true,
        197,
        426,
        78.60000000000001,
        235.79999999999998,
      ],
      [
        "tiny unchanged container",
        { left: 0, top: 0, right: 6, bottom: 6 },
        { width: 402, height: 874 },
        true,
        3,
        3,
        5.4,
        5.4,
      ],
    ] as const)(
      "d preserves exact on-screen %s geometry",
      async (_shape, bounds, size, explicit, centerX, centerY, start, end) => {
        setTarget(bounds, undefined, size);
        const result = await pinch.execute({
          direction: "out",
          container: explicit ? { elementId: "container-id" } : undefined,
        });
        expect(result.success).toBe(true);
        expect(history()[0]).toMatchObject({
          centerX,
          centerY,
          distanceStart: rounded(start),
          distanceEnd: rounded(end),
        });
        expect(result).toMatchObject({
          centerX,
          centerY,
          distanceStart: rounded(start),
          distanceEnd: rounded(end),
          scale: rounded(end) / rounded(start),
        });
      },
    );

    test.each([
      ["sliver", { left: 0, top: -500, right: 402, bottom: 6 }, "402x6"],
      ["off-screen", { left: 500, top: 0, right: 900, bottom: 500 }, "0x0"],
      ["touching edge", { left: 0, top: -100, right: 402, bottom: 0 }, "0x0"],
    ] as const)(
      "e rejects %s explicit target without dispatch",
      async (_shape, bounds, visibleSize) => {
        setTarget(bounds);
        const result = await pinch.execute({
          direction: "in",
          container: { elementId: "container-id" },
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain(`visible size ${visibleSize}`);
        expect(result.error).toContain("minimum 12");
        expect(result.error).toContain("scroll/zoom");
        expect(result.error).toContain("container/elementId");
        expect(android.getPinchHistory()).toEqual([]);
        expect(ios.getPinchHistory()).toEqual([]);
      },
    );

    test("e rejects an auto-targeted sliver without dispatch", async () => {
      setTarget({ left: 0, top: -500, right: 402, bottom: 6 });
      const result = await pinch.execute({ direction: "in" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("visible size 402x6");
      expect(history()).toEqual([]);
    });

    test("accepts a clipped target at the derived 12px minimum", async () => {
      setTarget({ left: 0, top: -500, right: 402, bottom: 12 });
      const result = await pinch.execute({ direction: "out", rotationDegrees: 90 });
      expect(result.success).toBe(true);
      expect(history()[0]).toMatchObject({
        centerX: 201,
        centerY: 6,
        distanceStart: 10,
        distanceEnd: 10,
      });
      expectFingersInside(history()[0], screenBounds);
    });

    test.each([false, true])(
      "clips against inset-aware bounds, includeSystemInsets=%s",
      async (includeSystemInsets) => {
        setTarget(measuredBounds, { top: 44, right: 12, bottom: 34, left: 10 });
        const result = await pinch.execute({ direction: "in", includeSystemInsets });
        expect(result.success).toBe(true);
        expect(history()[0]).toMatchObject(
          includeSystemInsets
            ? {
                centerX: 201,
                centerY: 437,
                distanceStart: rounded(241.2),
                distanceEnd: rounded(80.4),
              }
            : { centerX: 200, centerY: 442, distanceStart: 228, distanceEnd: 76 },
        );
        expectFingersInside(
          history()[0],
          includeSystemInsets ? screenBounds : { left: 10, top: 44, right: 390, bottom: 840 },
        );
      },
    );

    test("preserves inset-aware screen fallback geometry", async () => {
      setTarget(measuredBounds, { top: 44, right: 12, bottom: 34, left: 10 });
      const result = await pinch.execute({ direction: "out", autoTarget: false });
      expect(result.success).toBe(true);
      expect(result.targetType).toBe("screen");
      expect(history()[0]).toMatchObject({
        centerX: 200,
        centerY: 442,
        distanceStart: 76,
        distanceEnd: 228,
      });
    });
  });
}
