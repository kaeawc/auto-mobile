import { expect, test } from "bun:test";
import { executeXrPanelScroll } from "../../../../src/features/xr/xrPanelScroll";
import { SearchableHierarchy } from "../../../../src/features/utility/SearchableNode";
import { StaleDisplayError } from "../../../../src/features/observe/StaleDisplayError";
import type { SwipeGestureRequest } from "../../../../src/features/action/swipeon/types";
import { FakeCtrlProxy } from "../../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { spatialPanelObservation } from "../../../helpers/xrSpatialPanelFixture";

function setup() {
  const observation = spatialPanelObservation("switch-scroll");
  const service = new FakeCtrlProxy(new FakeTimer());
  service.setSupportsNodeActionSelectors(true);
  const request: SwipeGestureRequest = {
    observation,
    direction: "up",
    containerElement: null,
    x1: 100,
    y1: 1000,
    x2: 100,
    y2: 400,
  };
  return { observation, service, request };
}

for (const mode of ["aborted", "stale", "unsupported", "incomplete"] as const) {
  test(`panel node scroll ${mode} refuses before dispatch`, async () => {
    const { service, request, observation } = setup();
    if (mode === "aborted") {
      request.signal = AbortSignal.abort(new Error("cancelled"));
    } else if (mode === "stale") {
      request.gestureOptions = {
        displayFence: {
          assertCurrent: () => {
            throw new StaleDisplayError({
              observedGeneration: 1,
              currentGeneration: 2,
              retry: "observe",
            });
          },
        },
      };
    } else if (mode === "unsupported") {
      service.setSupportsNodeBoundsVerification(false);
    } else {
      observation.viewHierarchy!.ctrlProxyIncomplete = true;
    }
    await expect(executeXrPanelScroll(service, request, true)).rejects.toThrow(
      mode === "aborted"
        ? "cancelled"
        : mode === "unsupported"
          ? "Update CtrlProxy"
          : mode === "incomplete"
            ? "display-input swipe scrolling"
            : "Display changed",
    );
    expect(service.getNodeActionHistory()).toEqual([]);
  });
}

test("stable panel selectors retain expected bounds and do not need bounds-only identity", async () => {
  const { request, observation, service } = setup();
  for (const entry of new SearchableHierarchy().project(observation.viewHierarchy!)) {
    if (entry.properties["view-id"] === "s2-2b57a0f616cc9987") {
      Object.assign(entry.source, { "test-tag": "panel-list" });
    }
  }
  const result = await executeXrPanelScroll(service, request, true);
  expect(result?.success).toBe(true);
  expect(service.getNodeActionHistory()).toMatchObject([
    {
      action: "scroll_forward",
      selector: { testTag: "panel-list" },
      expectedBounds: { left: 32, top: 289, right: 2368, bottom: 1968 },
    },
  ]);
});

test("an unacknowledged panel scroll stops searches as indeterminate", async () => {
  const { request, service } = setup();
  service.setActionResult({
    success: false,
    action: "scroll_forward",
    totalTimeMs: 0,
    dispatched: true,
    acknowledged: false,
    error: "timeout",
  });
  expect(await executeXrPanelScroll(service, request, true)).toMatchObject({
    success: false,
    outcomeIndeterminate: true,
    retryable: false,
  });
});

test("panel scrolling reports nominal duration and pages the search without a timed stroke", async () => {
  const { request, service } = setup();
  const searchDragState = {};
  request.boomerang = { apexPauseMs: 100, returnSpeed: 2 };
  request.gestureOptions = { duration: 500, durationExplicit: true, searchDragState };
  const result = await executeXrPanelScroll(service, request, true);
  expect(result).toMatchObject({ success: true, durationIgnored: true, duration: 500 });
  expect(result!.warnings!.join(" ")).toContain("durationMs was ignored");
  expect(result!.warnings!.join(" ")).not.toContain("turn TalkBack off");
  expect(searchDragState).toEqual({ pagingStep: true });
  expect(result!.warnings!.join(" ")).toContain("performed one node scroll");
  expect(service.getNodeActionHistory()).toHaveLength(1);
});

test("a supplied scrollable at its end is refused rather than scrolling another node", async () => {
  const { request, service, observation } = setup();
  const entry = new SearchableHierarchy()
    .project(observation.viewHierarchy!)
    .find((entry) => entry.properties["view-id"] === "s2-2b57a0f616cc9987")!;
  request.containerElement = { ...entry.properties, bounds: entry.bounds! };
  for (const candidate of new SearchableHierarchy().project(observation.viewHierarchy!)) {
    if (candidate.properties["view-id"] === "s2-2b57a0f616cc9987") {
      candidate.source.actions = [];
    }
  }
  await expect(executeXrPanelScroll(service, request, true)).rejects.toThrow(
    "cannot scroll further",
  );
  expect(service.getNodeActionHistory()).toEqual([]);
});
