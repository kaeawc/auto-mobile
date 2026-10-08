import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { TapOnElement, type TapOnElementOptions } from "../../../src/features/action/TapOnElement";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { ownOverlayWindows } from "../../../src/features/observe/ownOverlayFocus";
import { projectSkeleton } from "../../../src/features/observe/output/SkeletonProjection";
import type { ElementBounds } from "../../../src/models/ElementBounds";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  OVERLAY_CAPTURE,
  capturedFloatingCoverHierarchy,
  capturedOverlayHierarchy,
  observationOf,
} from "../../helpers/overlayWindowCapture";

/**
 * Observe and default-layer tapOn must agree on every app row under an AutoMobile overlay window
 * (owner decision 2026-10-08, #10715): a row the overlay windows fully cover is `occluded` with no
 * actions and tapOn refuses it before dispatch; a row with an exposed part stays actionable and
 * tapOn taps that part, never inside an overlay window.
 *
 * Fixtures: the captured Recents overview with its floating window relabelled as the overlay
 * (opaque/translucent/sheet/floating/partial variants), and the device capture of a floating
 * prototype over the Playground buttons (test/fixtures/android-overlay-window/).
 */

const PLAYGROUND_SCREEN = { width: 1080, height: 2400 };

interface ParityCase {
  name: string;
  hierarchy: () => ViewHierarchyResult;
  screenSize?: ObserveResult["screenSize"];
  label: string;
  selector: TapOnElementOptions;
  covered: boolean;
}

function withOverlayBounds(hierarchy: ViewHierarchyResult, bounds: ElementBounds) {
  hierarchy.windows = hierarchy.windows!.map((window) =>
    window.id === OVERLAY_CAPTURE.overlayWindowId ? { ...window, bounds } : window,
  );
  return hierarchy;
}

const screenshot = {
  label: "Screenshot",
  selector: { action: "tap", text: "Screenshot" },
} as const;

const CASES: ParityCase[] = [
  {
    name: "opaque fullscreen overlay",
    hierarchy: () =>
      capturedOverlayHierarchy({
        fullScreen: true,
        overlayPlacement: "fullscreen",
        overlayOpaque: true,
      }),
    ...screenshot,
    covered: true,
  },
  {
    name: "translucent fullscreen overlay",
    hierarchy: () =>
      capturedOverlayHierarchy({
        fullScreen: true,
        overlayPlacement: "fullscreen",
        overlayOpaque: false,
      }),
    ...screenshot,
    covered: true,
  },
  {
    name: "sheet overlay spanning the row",
    hierarchy: () =>
      capturedOverlayHierarchy({
        fullScreen: true,
        overlayPlacement: "sheet",
        overlayOpaque: true,
      }),
    ...screenshot,
    covered: true,
  },
  {
    name: "overlay without metadata spanning the row (older APK)",
    hierarchy: () => capturedOverlayHierarchy({ fullScreen: true }),
    ...screenshot,
    covered: true,
  },
  {
    name: "overlay covering the left half of the row",
    hierarchy: () =>
      withOverlayBounds(
        capturedOverlayHierarchy({ overlayPlacement: "floating", overlayOpaque: false }),
        { left: 0, top: 1700, right: 733, bottom: 2152 },
      ),
    ...screenshot,
    covered: false,
  },
  {
    name: "overlay that does not reach the row",
    hierarchy: () =>
      capturedOverlayHierarchy({ overlayPlacement: "floating", overlayOpaque: true }),
    ...screenshot,
    covered: false,
  },
  {
    name: "captured floating translucent overlay over the Elevated button",
    hierarchy: capturedFloatingCoverHierarchy,
    screenSize: PLAYGROUND_SCREEN,
    label: "Elevated Button",
    selector: { action: "tap", elementId: "button_elevated" },
    covered: true,
  },
  {
    name: "captured floating overlay over the Regular button's right edge",
    hierarchy: capturedFloatingCoverHierarchy,
    screenSize: PLAYGROUND_SCREEN,
    label: "Regular Button",
    selector: { action: "tap", elementId: "button_regular" },
    covered: false,
  },
  {
    name: "captured floating overlay above the Text button",
    hierarchy: capturedFloatingCoverHierarchy,
    screenSize: PLAYGROUND_SCREEN,
    label: "Text Button",
    selector: { action: "tap", elementId: "button_text" },
    covered: false,
  },
];

function observationFor(parity: ParityCase): ObserveResult {
  const observation = observationOf(parity.hierarchy());
  return parity.screenSize ? { ...observation, screenSize: parity.screenSize } : observation;
}

function observedRow(observation: ObserveResult, label: string) {
  const { skeleton, context = [] } = projectSkeleton(
    observation.elements!,
    observation.screenSize,
    observation.viewHierarchy,
  );
  return [...skeleton, ...context].find((row) => row.label === label);
}

function createCommand(observation: ObserveResult) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const service = new FakeCtrlProxy(timer);
  spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(service);
  const detector = new FakeAccessibilityDetector();
  detector.setDefaultResult(false);
  const command = new TapOnElement(
    { name: "Fake Android", deviceId: "fake-android", platform: "android" },
    new FakeAdbExecutor(),
    {
      timer,
      accessibilityDetector: detector,
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    },
  );
  spyOn(command, "observedInteraction").mockImplementation(async (block) =>
    block(recordObservationRead(observation)),
  );
  return { command, service };
}

function inside(bounds: ElementBounds, point: { x: number; y: number }) {
  return (
    bounds.left <= point.x &&
    point.x < bounds.right &&
    bounds.top <= point.y &&
    point.y < bounds.bottom
  );
}

afterEach(() => {
  mock.restore();
});

describe("observe and default-layer tapOn agree on app rows under AutoMobile overlays (#10715)", () => {
  for (const parity of CASES) {
    test(parity.name, async () => {
      const observation = observationFor(parity);
      const row = observedRow(observation, parity.label);
      expect(row).toBeDefined();

      const { command, service } = createCommand(observation);
      const result = await command.execute(parity.selector);

      if (parity.covered) {
        expect(row).toMatchObject({ occluded: true, affordances: [] });
        expect(result.success).toBe(false);
        expect(result.error).toContain("AutoMobile overlay");
        expect(service.getTapHistory()).toEqual([]);
        return;
      }
      expect(row?.occluded).toBeUndefined();
      expect(row?.affordances).toContain("tap");
      expect(result.success).toBe(true);
      const [tap] = service.getTapHistory();
      const overlays = ownOverlayWindows(observation.viewHierarchy).map((window) => window.bounds!);
      expect(overlays.some((bounds) => inside(bounds, tap))).toBe(false);
    });
  }
});
