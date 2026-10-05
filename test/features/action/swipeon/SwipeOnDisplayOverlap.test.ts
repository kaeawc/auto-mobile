import { afterEach, expect, mock, test } from "bun:test";
import { harness } from "./displaySwipeHarness";
import type { ObserveResult } from "../../../../src/models";

afterEach(() => mock.restore());

function listFrame(observation: ObserveResult, page: number, found: boolean): ObserveResult {
  return {
    ...observation,
    viewHierarchy: {
      ...observation.viewHierarchy,
      hierarchy: {
        node: {
          $: {
            "resource-id": "list",
            scrollable: true,
            bounds: "[0,0][200,200]",
            class: "android.widget.ScrollView",
          },
          node: Array.from({ length: 6 }, (_, index) => ({
            $: {
              text: found && index === 0 ? "Found" : `page ${page} row ${index}`,
              "resource-id": "row",
              bounds: `[0,${index * 30}][200,${(index + 1) * 30}]`,
              class: "android.widget.TextView",
            },
          })),
        },
      },
    },
  };
}

for (const route of ["ctrlproxy", "adb"] as const) {
  for (const step of [1, 2]) {
    for (const read of [0, 1, 3]) {
      test(`invalid display read never authorizes overlap recovery: ${route}, step ${step}, read ${read}`, async () => {
        const reads = new Map<number, number>();
        const h = harness({
          route,
          foundAfter: Infinity,
          observationFor: ({ observation, swipes }) => {
            const index = reads.get(swipes) ?? 0;
            reads.set(swipes, index + 1);
            const invalid = swipes === step && index === read;
            // Wrong-panel frames contain the target and dense zero-overlap evidence.
            const capture = listFrame(observation, swipes, invalid);
            return invalid
              ? {
                  ...capture,
                  display: { ...capture.display, key: "internal" },
                  viewHierarchy: { ...capture.viewHierarchy, displayId: 0 },
                }
              : capture;
          },
        });
        h.useRealObservedInteraction();
        const result = await h.action.execute({
          direction: "up",
          display: "external",
          lookFor: { text: "Found", maxTime: 3000 },
        });
        expect(result.success).toBe(false);
        expect(result.found).not.toBe(true);
        expect(result.error).toContain("gesture was dispatched");
        expect(result.error).toContain("Do not retry automatically");
        expect(result.staleDisplay?.retry).toBe("observe");
        expect(h.legs()).toHaveLength(step);
        expect(h.legs().map((leg) => leg.y2 > leg.y1)).toEqual(
          step === 1 ? [false] : [false, true],
        );
        expect(h.legs().every((leg) => leg.duration === 600)).toBe(true);
        expect(h.legs().every((leg) => Math.abs(leg.y2 - leg.y1) <= 150)).toBe(true);
      });
    }
  }
  test(`recovery keeps a validated target when the later settle read fails: ${route}`, async () => {
    let recoveryReads = 0;
    const h = harness({
      route,
      foundAfter: Infinity,
      observationFor: ({ observation, swipes }) => {
        const invalid = swipes === 2 && recoveryReads++ === 1;
        const capture = listFrame(observation, swipes, swipes === 2);
        return invalid ? { ...capture, display: { ...capture.display, key: "internal" } } : capture;
      },
    });
    h.useRealObservedInteraction();
    const result = await h.action.execute({
      direction: "up",
      display: "external",
      lookFor: { text: "Found", maxTime: 3000 },
    });
    expect(result).toMatchObject({
      success: true,
      found: true,
      element: { text: "Found" },
      observation: { display: { key: "external" }, settled: false },
      staleDisplay: { retry: "observe" },
    });
    expect(h.legs()).toHaveLength(2);
    expect(h.legs()[1].y2).toBeGreaterThan(h.legs()[1].y1);
    expect(result.observation?.freshness?.warning).toContain("display settle");
  });
}
