import { TapAtCoordinate } from "../../src/features/action/TapAtCoordinate";
import type { CoordinateTapClient } from "../../src/features/action/coordinateTapDispatch";
import type { SnapshotReferenceStore } from "../../src/features/observe/SnapshotReferenceStore";
import type { BootedDevice, ObserveResult } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";

export function observation(
  width: number,
  height: number,
  frameContext = "frame-123",
  rotation = 0,
  node: Record<string, unknown> = {},
): ObserveResult {
  return {
    observationId: "test-observation",
    timestamp: 1,
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
  } as ObserveResult;
}

export function createTapAt(
  device: BootedDevice,
  width = 10,
  height = 10,
  onIosDispatch?: (timer: FakeTimer) => void,
  renderedDisplayRevision?: () => number | undefined,
  snapshotReferences?: SnapshotReferenceStore,
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
  const iosDispatches: Array<{ x: number; y: number; duration: number; frameContext?: string }> =
    [];
  const unusedClient: CoordinateTapClient = {
    requestTapCoordinates: async () => ({ success: true }),
  };
  const tapAt = new TapAtCoordinate(device, new FakeAdbExecutor(), {
    timer,
    renderedDisplayRevision,
    snapshotReferences,
    androidClient: unusedClient,
    iosClient: unusedClient,
    dispatchAndroidCoordinateTap: async (_client, _adb, x, y, duration, frameContext) => {
      androidDispatches.push({ x, y, duration, frameContext });
    },
    dispatchIosCoordinateTap: async (_client, x, y, duration, frameContext) => {
      iosDispatches.push({ x, y, duration, frameContext });
      onIosDispatch?.(timer);
    },
    invalidateIosCache: () => {
      iosCacheInvalidations++;
    },
  });
  tapAt.observeScreen = observeScreen;
  return {
    tapAt,
    observeScreen,
    androidDispatches,
    iosDispatches,
    timer,
    iosCacheInvalidations: () => iosCacheInvalidations,
  };
}
