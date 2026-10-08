import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { createStructuredToolResponse, getStructuredPayload } from "../../src/utils/toolUtils";
import { serverConfig } from "../../src/utils/ServerConfig";
import { DefaultObserveElementCollector } from "../../src/features/observe/ObserveElementCollector";
import type { ObserveResult } from "../../src/models/ObserveResult";

// Real emulator capture of Settings > Open by default (1080x2424): status bar chrome over
// the Settings window, whose radio rows sit at y=1054..1364.
const capture: ObserveResult = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/android-settings/open-by-default-radio-rows.observe.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function observe(args: Record<string, unknown>): ObserveResult {
  const source: ObserveResult = {
    ...capture,
    elements: new DefaultObserveElementCollector().collect(capture.viewHierarchy!, "android"),
  };
  const payload = getStructuredPayload<ObserveResult>(
    finalizeToolResponse(createStructuredToolResponse(source), { name: "observe", args }),
  );
  if (!payload) {
    throw new Error("Expected structured observe payload");
  }
  return payload;
}

const labels = (rows: ObserveResult["skeleton"]) => (rows ?? []).map((row) => row.label);

beforeEach(() => serverConfig.setActionsDiffObserveEnabled(false));
afterEach(() => serverConfig.setActionsDiffObserveEnabled(false));

test("default skeleton honors a focus anchor instead of silently ignoring scope", () => {
  const full = observe({});
  expect(labels(full.skeleton)).toContain("Navigate up");
  expect(full.observeScope).toBeUndefined();

  const out = observe({
    scope: { focus: { resourceId: "com.android.settings:id/recycler_view" } },
  });

  expect(out.viewHierarchy).toBeUndefined();
  expect(out.observeScope).toMatchObject({ applied: ["focus"], focus: { matched: true } });
  expect(labels(out.skeleton)).not.toContain("Navigate up");
  expect(labels(out.skeleton)).toEqual(
    expect.arrayContaining(["In the app", "In your browser", "0 verified links"]),
  );
  expect(out.skeleton!.length).toBeLessThan(full.skeleton!.length);
});

test("default skeleton crops to a region box and reports overview as withheld", () => {
  const out = observe({
    scope: { region: { x1: 0, y1: 0.5, x2: 1, y2: 0.55 }, overview: true },
  });

  expect(out.observeScope).toMatchObject({
    applied: ["region"],
    gatedOff: ["overview"],
    regionPx: { left: 0, top: 1212, right: 1080, bottom: 1333.2 },
  });
  // Of the rows, only "In your browser" (1209..1364) intersects y=1212..1333; the row and
  // its radio button survive, as does the list (612..1956) that scrolls them.
  expect(out.skeleton!.map((row) => [row.label, row.affordances])).toEqual([
    ["In your browser", ["tap"]],
    ["In your browser", ["toggle"]],
    [undefined, ["scroll"]],
  ]);
});
