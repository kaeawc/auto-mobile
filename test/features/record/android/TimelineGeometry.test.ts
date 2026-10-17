import { describe, expect, test } from "bun:test";
import { withTimelineGeometry } from "../../../../src/features/record/android/DualTrackRecorder";
import { ScreenGeometryTimeline } from "../../../../src/features/record/android/ScreenGeometryTimeline";
import type { GestureEmitter, GestureEvent } from "../../../../src/features/record/android/types";
import { FakeTimer } from "../../../fakes/FakeTimer";

const AXES = { xMin: 0, xMax: 32767, yMin: 0, yMax: 32767 };

function setup() {
  const timer = new FakeTimer();
  timer.advanceTime(1000);
  const timeline = new ScreenGeometryTimeline(
    AXES,
    { rotation: 0, display: { width: 1080, height: 2400 } },
    timer.now(),
  );
  let emit: (event: GestureEvent) => void = () => {};
  const inner: GestureEmitter = {
    start: (onGesture) => {
      emit = onGesture;
    },
    stop: () => {},
  };
  const out: GestureEvent[] = [];
  withTimelineGeometry(inner, timeline, timer).start(
    (event) => out.push(event),
    () => {},
  );
  return { timer, timeline, out, emit: (event: GestureEvent) => emit(event) };
}

describe("withTimelineGeometry (#12880)", () => {
  test("gestures before and after a rotation carry the geometry in force at their DOWN", () => {
    const { timer, timeline, out, emit } = setup();
    emit({ type: "tap", arrivedAt: 1100, downAt: 1050 });
    timer.advanceTime(1000);
    timeline.apply({ rotation: 1 }, timer.now());
    timer.advanceTime(500);
    emit({ type: "swipe", arrivedAt: timer.now() + 100, downAt: timer.now() });

    expect(out[0].geometry).toEqual({
      platform: "android",
      deviceWidth: 1080,
      deviceHeight: 2400,
      orientation: 0,
    });
    expect(out[1].geometry).toEqual({
      platform: "android",
      deviceWidth: 2400,
      deviceHeight: 1080,
      orientation: 1,
    });
  });

  test("a gesture without downAt falls back to the current timeline entry", () => {
    const { timer, timeline, out, emit } = setup();
    timer.advanceTime(1000);
    timeline.apply({ rotation: 1 }, timer.now());
    emit({ type: "tap", arrivedAt: timer.now() });

    expect(out[0].geometry?.orientation).toBe(1);
  });
});
