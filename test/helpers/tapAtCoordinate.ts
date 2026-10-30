import { buildObserveResult } from "./observeFixture";
import { TapAtCoordinate } from "../../src/features/action/TapAtCoordinate";
import type {
  CoordinateTapClient,
  IosCoordinateTapClient,
} from "../../src/features/action/coordinateTapDispatch";
import type { SnapshotReferenceStore } from "../../src/features/observe/SnapshotReferenceStore";
import type { RenderedObservationReader } from "../../src/features/action/TargetDisplayAction";
import type { BootedDevice, ObserveResult } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeWindow } from "../fakes/FakeWindow";

export function setFakeTapAtWindow(tapAt: TapAtCoordinate): void {
  // Coordinate dispatch tests must not read the persistent per-device window cache.
  tapAt.window = new FakeWindow();
}

export function observation(
  width: number,
  height: number,
  frameContext = "frame-123",
  rotation = 0,
  node: Record<string, unknown> = {},
): ObserveResult {
  return buildObserveResult({
    observationId: "test-observation",
    updatedAt: 1,
    screenSize: { width, height },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    rotation,
    viewHierarchy: {
      hierarchy: { node },
      frameContext,
      nativeScale: 1,
      rotation,
      screenWidth: width,
      screenHeight: height,
    },
  });
}

export function createTapAt(
  device: BootedDevice,
  width = 10,
  height = 10,
  onIosDispatch?: (timer: FakeTimer) => void,
  renderedDisplayRevision?: () => number | undefined,
  snapshotReferences?: SnapshotReferenceStore,
  rejectIosDispatchAt?: number,
  lastRenderedObservation?: RenderedObservationReader,
) {
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveResult(observation(width, height));
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  let iosCacheInvalidations = 0;
  const androidDispatches: Array<{
    x: number;
    y: number;
    duration: number;
    frameContext?: string;
  }> = [];
  const iosDispatches: Array<{
    kind: "double" | "tap";
    x: number;
    y: number;
    duration: number;
    frameContext?: string;
  }> = [];
  let iosDispatchCount = 0;
  const unusedClient: CoordinateTapClient = {
    requestTapCoordinates: async () => ({ success: true }),
  };
  const adb = new FakeAdbExecutor();
  const tapAt = new TapAtCoordinate(device, adb, {
    timer,
    renderedDisplayRevision,
    snapshotReferences,
    lastRenderedObservation,
    androidClient: unusedClient,
    iosClient: {
      ...unusedClient,
      requestDoubleTapCoordinates: async () => ({ success: true }),
    } satisfies IosCoordinateTapClient,
    dispatchAndroidCoordinateTap: async (_client, _adb, { x, y }, duration, options) => {
      androidDispatches.push({ x, y, duration, frameContext: options?.frameContext });
    },
    dispatchIosDoubleTap: async (_client, { x, y }, _duration, frameContext) => {
      iosDispatches.push({ kind: "double", x, y, duration: 50, frameContext });
      iosDispatchCount++;
      onIosDispatch?.(timer);
      if (iosDispatchCount === rejectIosDispatchAt) {
        throw new Error("Synthetic iOS tap rejection");
      }
    },
    dispatchIosCoordinateTap: async (_client, { x, y }, duration, frameContext) => {
      iosDispatches.push({ kind: "tap", x, y, duration, frameContext });
      iosDispatchCount++;
      onIosDispatch?.(timer);
      if (iosDispatchCount === rejectIosDispatchAt) {
        throw new Error("Synthetic iOS tap rejection");
      }
    },
    invalidateIosCache: () => {
      iosCacheInvalidations++;
    },
  });
  setFakeTapAtWindow(tapAt);
  tapAt.observeScreen = observeScreen;
  return {
    tapAt,
    adb,
    observeScreen,
    androidDispatches,
    iosDispatches,
    timer,
    iosCacheInvalidations: () => iosCacheInvalidations,
  };
}
