import { describe, expect, test } from "bun:test";
import {
  PROTOTYPE_DISMISS_ID,
  PROTOTYPE_WINDOW_MARKER_IDENTIFIERS,
  isPrototypeHostDismissId,
  resolveTapOffHostControls,
} from "../../../src/features/prototype/prototypeHostControls";

const target = { left: 100, top: 100, right: 200, bottom: 160 };
const control = (left: number, right: number) => ({
  id: PROTOTYPE_DISMISS_ID,
  bounds: { left, top: 90, right, bottom: 170 },
});

describe("host dismiss control ids", () => {
  test("the id is the one iOS draws and marks its window with", () => {
    expect(PROTOTYPE_DISMISS_ID).toBe("automobile-prototype-dismiss");
    expect(PROTOTYPE_WINDOW_MARKER_IDENTIFIERS).toEqual([
      "automobile-prototype-window",
      "automobile-prototype-dismiss",
    ]);
  });

  test("only the bare resource id is a host control; a package-qualified look-alike is authored", () => {
    expect(isPrototypeHostDismissId("automobile-prototype-dismiss")).toBe(true);
    expect(isPrototypeHostDismissId("dev.example:id/automobile-prototype-dismiss")).toBe(false);
    expect(isPrototypeHostDismissId("automobile-prototype-dismiss-2")).toBe(false);
    expect(isPrototypeHostDismissId("my-dismiss")).toBe(false);
    expect(isPrototypeHostDismissId(undefined)).toBe(false);
  });
});

describe("resolveTapOffHostControls", () => {
  const point = { x: 150, y: 130 };

  test("proceeds unchanged when no control covers the point", () => {
    expect(
      resolveTapOffHostControls({ controls: [control(300, 400)], visibleBounds: target, point }),
    ).toEqual({ kind: "proceed", point });
    expect(resolveTapOffHostControls({ controls: [], visibleBounds: target, point })).toEqual({
      kind: "proceed",
      point,
    });
  });

  test("moves to the centre of the largest part outside the control", () => {
    expect(
      resolveTapOffHostControls({ controls: [control(140, 200)], visibleBounds: target, point }),
    ).toEqual({ kind: "proceed", point: { x: 119, y: 129 } });
  });

  test("avoids every control, not just the one over the point", () => {
    const decision = resolveTapOffHostControls({
      controls: [control(140, 160), control(100, 120)],
      visibleBounds: target,
      point,
    });
    expect(decision).toEqual({ kind: "proceed", point: { x: 179, y: 129 } });
  });

  test("refuses by naming the control when it covers the whole target", () => {
    expect(
      resolveTapOffHostControls({ controls: [control(90, 210)], visibleBounds: target, point }),
    ).toEqual({ kind: "refuse", control: PROTOTYPE_DISMISS_ID });
  });

  test("a target that is itself a host control is tapped as asked", () => {
    expect(
      resolveTapOffHostControls({
        controls: [control(90, 210)],
        targetId: PROTOTYPE_DISMISS_ID,
        visibleBounds: target,
        point,
      }),
    ).toEqual({ kind: "proceed", point });
  });
});
