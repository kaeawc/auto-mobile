import { FakeAvdColdBootMarkerStore } from "../fakes/FakeAvdColdBootMarkerStore";
import { describe, expect, test } from "bun:test";
import type { AndroidAutoProjectionApplier } from "../../src/features/androidAuto/AndroidAutoProjectionService";
import type { ShutdownDeadlineContext } from "../../src/features/deviceLifecycle/deviceLifecycleCore";
import {
  stopAndroidAutoBeforeShutdown,
  trackAndroidAutoStopAfterKill,
} from "../../src/server/deviceToolsShutdownAndroidAuto";
import { FakeTimer } from "../fakes/FakeTimer";

const flush = async () => {
  for (let index = 0; index < 10; index++) {
    await Promise.resolve();
  }
};

/** A post-kill DHU stop the test settles by hand. */
function setup() {
  const timer = new FakeTimer();
  let settleStop: () => void = () => {};
  let stopStarted = false;
  const applier: AndroidAutoProjectionApplier = {
    resolveInputs: async () => {
      throw new Error("not used");
    },
    apply: async () => {
      throw new Error("not used");
    },
    resolveHeadUnitInputs: async () => {
      throw new Error("not used");
    },
    startHeadUnit: async () => {
      throw new Error("not used");
    },
    stopDesktopHeadUnit: async () => {
      stopStarted = true;
      await new Promise<void>((resolve) => {
        settleStop = resolve;
      });
      return false;
    },
  };
  const retained: Array<{ operation: Promise<unknown>; releaseAfterFailure?: boolean }> = [];
  const context: ShutdownDeadlineContext = {
    device: { deviceId: "emulator-5554", platform: "android", name: "Pixel" },
    timer,
    deadlineMs: timer.now() + 10_000,
    timeoutMs: 10_000,
    requestAbortSignal: undefined,
    retainReservationUntil: (operation, releaseAfterFailure) => {
      retained.push({ operation, releaseAfterFailure });
    },
  };
  const tracker = trackAndroidAutoStopAfterKill(context, {
    timer,
    androidAutoProjection: applier,
  });
  return {
    tracker,
    context,
    applier,
    retained,
    timer,
    settle: () => settleStop(),
    stopStarted: () => stopStarted,
  };
}

describe("trackAndroidAutoStopAfterKill", () => {
  test("a failure while the post-kill wait is in flight holds the reservation until the stop settles", async () => {
    const { tracker, retained, settle, stopStarted } = setup();
    const confirmed = tracker.onShutdownConfirmed();
    await flush();
    expect(stopStarted()).toBe(true);

    tracker.retainAfterFailure();
    tracker.retainAfterFailure();
    expect(retained).toHaveLength(1);
    expect(retained[0]!.releaseAfterFailure).toBe(true);
    let held = true;
    void retained[0]!.operation.then(() => {
      held = false;
    });
    await flush();
    expect(held).toBe(true);

    settle();
    await confirmed;
    await flush();
    expect(held).toBe(false);
  });

  test("a failure after the stop outlived its wait holds the reservation for that stop", async () => {
    const { tracker, retained, settle, timer } = setup();
    const confirmed = tracker.onShutdownConfirmed();
    await flush();
    timer.advanceTime(10_000);
    await confirmed;

    tracker.retainAfterFailure();
    expect(retained).toHaveLength(1);
    let held = true;
    void retained[0]!.operation.then(() => {
      held = false;
    });
    await flush();
    expect(held).toBe(true);
    settle();
    await flush();
    expect(held).toBe(false);
  });

  test("a stop that settled within its wait leaves nothing to hold", async () => {
    const { tracker, retained, settle } = setup();
    const confirmed = tracker.onShutdownConfirmed();
    await flush();
    settle();
    await confirmed;

    tracker.retainAfterFailure();
    expect(retained).toHaveLength(0);
    let released = false;
    await tracker.releaseReservation(
      async () => {
        released = true;
      },
      () => {
        throw new Error("nothing to retain");
      },
    );
    expect(released).toBe(true);
  });
});

for (const stopped of [true, false]) {
  test(`pre-kill shutdown records the AVD only when DHU stopped=${stopped}`, async () => {
    const { context, applier, timer } = setup();
    const markers = new FakeAvdColdBootMarkerStore();
    applier.stopDesktopHeadUnit = async () => stopped;
    // The shutdown caller cannot dispatch its console kill until this operation settles.
    await stopAndroidAutoBeforeShutdown(context, {
      timer,
      androidAutoProjection: applier,
      avdColdBootMarkers: markers,
    });
    expect(markers.calls).toEqual(stopped ? ["write:Pixel"] : []);
    expect(await markers.isMarked("Pixel")).toBe(stopped);
  });
}

test("marker write failure does not fail pre-kill shutdown", async () => {
  const { context, applier, timer } = setup();
  applier.stopDesktopHeadUnit = async () => true;
  const markers = new FakeAvdColdBootMarkerStore();
  markers.failure = "write";
  await stopAndroidAutoBeforeShutdown(context, {
    timer,
    androidAutoProjection: applier,
    avdColdBootMarkers: markers,
  });
  expect(markers.calls).toEqual(["write:Pixel"]);
});
