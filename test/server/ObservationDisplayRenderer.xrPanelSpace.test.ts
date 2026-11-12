import { beforeAll, expect, test } from "bun:test";
import { ObservationDisplayRenderer } from "../../src/server/ObservationDisplayRenderer";
import { ObserveElementsBuilder } from "../../src/features/observe/ObserveElementsBuilder";
import { buildObserveScopeConfig } from "../../src/features/observe/output/ObserveScopeExperiments";
import type { ObserveResult } from "../../src/models";
import { spatialPanelObservation } from "../helpers/xrSpatialPanelFixture";

const xrPanelSpace = { windowId: 93, bounds: { left: 0, top: 0, right: 2768, bottom: 2400 } };

function aggregate(xr: boolean): ObserveResult {
  const observation = spatialPanelObservation();
  if (xr) {
    observation.xrPanelSpace = xrPanelSpace;
  }
  observation.elements = new ObserveElementsBuilder().build(
    observation.viewHierarchy!,
    "android",
    xr,
    observation,
  );
  const { display, screenSize, viewHierarchy, elements } = observation;
  const entry = {
    display,
    screenSize,
    viewHierarchy,
    elements,
    freshness: { isFresh: true },
    ...(xr ? { xrPanelSpace } : {}),
  };
  return { ...observation, displays: [entry] };
}

function render(observation: ObserveResult, project: "full" | "skeleton") {
  const renderer = new ObservationDisplayRenderer({
    cfg: { dropElements: false, compact: true, project },
    scopeActive: false,
    scopeConfig: buildObserveScopeConfig({ focus: false, overview: false, region: false }, {}),
    resolveProjection: () => project,
  });
  return renderer.render(observation, observation, observation).displays![0]!;
}

// Building elements from the capture is setup, not the rendering under test.
const aggregates = new Map<boolean, ObserveResult>();
beforeAll(() => {
  aggregates.set(true, aggregate(true));
  aggregates.set(false, aggregate(false));
});

test.each(["full", "skeleton"] as const)(
  "display: all keeps each display's XR panel space (%s)",
  (project) => {
    const panel = render(aggregates.get(true)!, project);
    // The served form carries compact `[left, top, right, bottom]` bounds.
    expect<unknown>(panel.xrPanelSpace).toEqual({ windowId: 93, bounds: [0, 0, 2768, 2400] });
  },
);

test("display: all off XR emits no panel space", () => {
  const serialized = JSON.stringify(render(aggregates.get(false)!, "full"));
  expect(serialized).not.toContain("xrPanelSpace");
  expect(serialized).not.toContain("boundsSpace");
});
