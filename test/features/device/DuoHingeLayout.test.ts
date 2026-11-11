import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Posture } from "../../../src/models";
import { join } from "node:path";
import {
  InMemoryIosRequestedHingeAngleStore,
  iosHingeExpectedPanelRole,
  iosHingeLayoutWarning,
  iosPostureForPanel,
} from "../../../src/features/device/DuoHingeLayout";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/ios-duo-hinge", name), "utf8");

/** `target=<deg> panel=<cover|inner> app: status=<n> angleDeg=<deg> view=<w>x<h>` per line. */
function sweep(name: string): Array<{ target: number; panel: "cover" | "inner"; status: number }> {
  return fixture(name)
    .split("\n")
    .filter((line) => line.startsWith("target="))
    .map((line) => {
      const fields = Object.fromEntries(
        line
          .replace(" app:", "")
          .split(" ")
          .map((pair) => pair.split("=") as [string, string]),
      );
      const panel = fields.panel === "inner" ? "inner" : "cover";
      return { target: Number(fields.target), panel, status: Number(fields.status) };
    });
}

describe("iPhone Duo hinge/layout assessment (#17726)", () => {
  const rows = [...sweep("app-hinge-sweep-1.txt"), ...sweep("app-hinge-sweep-2.txt")];

  test("the captured sweeps parse into hinge/layout pairs", () => {
    expect(rows).toHaveLength(33);
    // UIKit reports closed (1) exactly when the cover layout is shown.
    expect(rows.every((row) => (row.panel === "cover") === (row.status === 1))).toBe(true);
  });

  test("the captured cover read at 90 needs settling; other captured pairs do not warn", () => {
    expect(rows.filter((row) => iosHingeLayoutWarning(row.target, row.panel))).toEqual([
      { target: 90, panel: "cover", status: 1 },
    ]);
  });

  test("captured pairs map to the UIHinge status the app saw", () => {
    const expected: Record<number, Posture> = { 1: "closed", 2: "half_opened", 3: "opened" };
    for (const row of rows) {
      expect(iosPostureForPanel(row.panel, row.target)).toBe(expected[row.status]);
    }
  });

  test("the stuck 0 -> 80 -> 120 state warns with a recovery step", () => {
    // The app read UIHinge.status closed at 118.3 degrees on the cover layout.
    const warning = iosHingeLayoutWarning(120, "cover");
    expect(warning).toContain("requested 120 degrees, but the cover panel is still active");
    expect(warning).toContain("hingeAngle 180, then the target angle again");
  });

  test("cover is plausible below 90 degrees and warns at 90 or above", () => {
    expect(iosHingeLayoutWarning(89.5, "cover")).toBeUndefined();
    expect(iosHingeLayoutWarning(90, "cover")).toContain(
      "requested 90 degrees, but the cover panel is still active",
    );
    expect(iosHingeLayoutWarning(91, "cover")).toBeDefined();
  });

  test("an inner panel at 0 degrees warns; inner never warns above 0", () => {
    expect(iosHingeLayoutWarning(0, "inner")).toContain('posture "closed"');
    expect(iosHingeLayoutWarning(1, "inner")).toBeUndefined();
    expect(iosHingeLayoutWarning(0, "cover")).toBeUndefined();
  });

  test.each([
    ["cover", 120, "closed"],
    ["cover", undefined, "closed"],
    ["inner", undefined, "opened"],
    ["inner", 0, "opened"],
    ["inner", 0.5, "half_opened"],
    ["inner", 179.5, "half_opened"],
    ["inner", 180, "opened"],
  ] as const)("panel %s at %p reports %s", (panel, angle, posture) => {
    expect(iosPostureForPanel(panel, angle)).toBe(posture);
  });

  test("the store keeps the last requested angle per device", () => {
    const store = new InMemoryIosRequestedHingeAngleStore();
    expect(store.requested("a")).toBeUndefined();
    store.record("a", 80);
    store.record("a", 120);
    store.record("b", 0);
    expect(store.requested("a")).toBe(120);
    expect(store.requested("b")).toBe(0);
  });

  test("the panel to wait for agrees with the layout warning thresholds", () => {
    expect(iosHingeExpectedPanelRole(0)).toBe("cover");
    expect(iosHingeExpectedPanelRole(45)).toBeUndefined();
    expect(iosHingeExpectedPanelRole(89.5)).toBeUndefined();
    expect(iosHingeExpectedPanelRole(90)).toBe("inner");
    expect(iosHingeExpectedPanelRole(91)).toBe("inner");
    for (const angle of [0, 45, 90, 120, 180]) {
      const expected = iosHingeExpectedPanelRole(angle);
      if (expected) {
        expect(iosHingeLayoutWarning(angle, expected)).toBeUndefined();
      }
    }
  });
});
