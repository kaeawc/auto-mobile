import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import { wearSurfaceKind } from "../../../src/features/wear/wearSurfaceKind";

type SurfaceObservation = Pick<ObserveResult, "activeWindow" | "viewHierarchy">;

function captured(name: string): SurfaceObservation {
  return JSON.parse(
    readFileSync(new URL(`../../fixtures/wear/surface/${name}.json`, import.meta.url), "utf8"),
  );
}

describe("wearSurfaceKind", () => {
  test.each([
    ["observe-project-full-watchface", "watchface"],
    ["observe-project-full-launcher-recents", "launcher"],
    ["observe-project-full-launcher-allapps", "launcher"],
    ["observe-project-full-app-settings", "app"],
    ["observe-project-full-tile-favorites", "tile"],
    ["observe-project-full-notification-tray", undefined],
    ["observe-full-tile-showing", "tile"],
    ["observe-full-app-in-front", "app"],
  ] as const)("classifies captured %s as %s", (name, expected) => {
    expect(wearSurfaceKind(captured(name))).toBe(expected);
  });

  test("missing foreground identity or hierarchy leaves the surface unknown", () => {
    const observation = captured("observe-project-full-watchface");
    expect(wearSurfaceKind({})).toBeUndefined();
    expect(wearSurfaceKind({ viewHierarchy: observation.viewHierarchy })).toBeUndefined();
    for (const name of [
      "observe-project-full-app-settings",
      "observe-project-full-launcher-recents",
      "observe-project-full-tile-favorites",
    ]) {
      expect(wearSurfaceKind({ activeWindow: captured(name).activeWindow })).toBeUndefined();
    }
  });

  test("an unrecognized sysui activity cannot inherit watchface evidence", () => {
    const observation = captured("observe-project-full-watchface");
    expect(
      wearSurfaceKind({
        ...observation,
        activeWindow: observation.activeWindow && {
          ...observation.activeWindow,
          activityName: "unrecognized",
        },
      }),
    ).toBeUndefined();
  });
});
