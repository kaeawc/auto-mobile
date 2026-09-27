import { expect, test } from "bun:test";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import { FakeTimer } from "../../fakes/FakeTimer";
import { DebugSearch } from "../../../src/features/debug/DebugSearch";
import type { BootedDevice, ViewHierarchyResult } from "../../../src/models";
const bounds = { left: 0, top: 0, right: 20, bottom: 20 };
const search = (capture: ViewHierarchyResult) =>
  new DebugSearch({ platform: "android" } as BootedDevice, undefined, new FakeTimer(), undefined, {
    capture: async (request) => ({
      captureId: "test",
      platform: "android",
      requestedFreshness: request.freshness,
      receivedAt: 0,
      hierarchy: capture,
      nodes: new SearchableHierarchy().project(capture),
    }),
  });
test("debug search requests current hierarchy rather than cached coordinates", async () => {
  let freshness: string | undefined;
  const feature = new DebugSearch(
    { platform: "android" } as BootedDevice,
    undefined,
    new FakeTimer(),
    undefined,
    {
      capture: async (request) => {
        freshness = request.freshness;
        return {
          captureId: "fresh",
          platform: "android",
          requestedFreshness: request.freshness,
          receivedAt: 0,
          hierarchy: capture({ text: "Current" }),
          nodes: new SearchableHierarchy().project(capture({ text: "Current" })),
        };
      },
    },
  );
  await feature.execute({ text: "Current" });
  expect(freshness).toBe("fresh");
});
const capture = (...nodes: object[]) => ({
  hierarchy: { node: nodes.map((node) => ({ bounds, clickable: true, ...node })) },
});
test("debug IDs default to namespace and explicit contains never claims exact", async () => {
  const feature = search(
    capture({ "resource-id": "app:id/login" }, { "resource-id": "app:id/login_help" }),
  );
  const exact = await feature.execute({ resourceId: "login" });
  expect(exact.matches).toHaveLength(1);
  expect(exact.matches[0].matchKind).toBe("id-namespace");
  expect(exact.matches[0].isExactMatch).toBe(true);
  const partial = await feature.execute({ resourceId: "login", match: "contains" });
  expect(partial.matches).toHaveLength(2);
  expect(partial.matches.every((match) => !match.isExactMatch)).toBe(true);
});
test("debug explains all matching fields once and finds synthetic keys", async () => {
  const feature = search(capture({ text: "Save", "content-desc": "Save", "view-id": "synthetic" }));
  const result = await feature.execute({ text: "Save" });
  expect(result.matches).toHaveLength(1);
  expect(result.matches[0].matchedProperties).toEqual(["text", "content-desc"]);
  expect((await feature.execute({ resourceId: "synthetic" })).matches[0].matchKind).toBe(
    "node-key-exact",
  );
});
test("contains lookup reports a synthetic ID as a view ID", async () => {
  const feature = search(capture({ "view-id": "synthetic-key", clickable: true }));
  const result = await feature.execute({ resourceId: "synthetic", match: "contains" });
  expect(result.matches[0].matchedProperty).toBe("view-id");
  expect(result.matches[0].matchedValue).toBe("synthetic-key");
  expect(result.matches[0].matchKind).toBe("contains");
});
test("debug selection follows tap eligibility and missing containers never search globally", async () => {
  const feature = search(capture({ text: "Save", clickable: false }, { text: "Save" }));
  const result = await feature.execute({ text: "Save" });
  expect(result.matches).toHaveLength(2);
  expect(result.selectedMatch?.element).toBe(result.matches[1].element);
  expect(
    (await feature.execute({ text: "Save", container: { elementId: "missing" } })).matches,
  ).toHaveLength(0);
  const exactMissing = await feature.execute({
    text: "Save",
    match: "exact",
    container: { text: "missing" },
  });
  expect(exactMissing.query.match).toBe("exact");
  expect(exactMissing.query.partialMatch).toBe(false);
});
test("debug sees secondary windows in resolver rank order", async () => {
  const feature = search({
    ...capture({ text: "Open", "resource-id": "main" }),
    windows: [
      {
        windowLayer: 10,
        hierarchy: { node: [{ bounds, clickable: true, text: "Open", "resource-id": "dialog" }] },
      },
    ],
  });
  const result = await feature.execute({ text: "Open" });
  expect(result.matches.map((match) => match.resourceId)).toEqual(["dialog", "main"]);
  expect(result.selectedMatch?.resourceId).toBe("dialog");
});
test("debug reports the actual promoted action target separately from the matching candidate", async () => {
  const feature = search(
    capture({
      "resource-id": "tap-row",
      children: [
        {
          bounds: { left: 1, top: 1, right: 10, bottom: 10 },
          text: "Child",
          actions: ["set_text"],
        },
      ],
    }),
  );
  const result = await feature.execute({ text: "Child" });
  expect(result.matches[0].element["resource-id"]).toBeUndefined();
  expect(result.selectedMatch?.element["resource-id"]).toBe("tap-row");
});

test("debug preserves exact child text provenance after semantic parent promotion", async () => {
  const feature = search(
    capture({
      text: "Account",
      "resource-id": "row",
      children: [{ text: "Save", bounds: { left: 1, top: 1, right: 10, bottom: 10 } }],
    }),
  );
  const result = await feature.execute({ text: "Save" });
  expect(result.matches[0].matchedValue).toBe("Save");
  expect(result.matches[0].matchedProperties).toEqual(["text"]);
  expect(result.matches[0].isExactMatch).toBe(true);
  expect(result.matches[0].element.text).toBe("Save");
  expect(result.matches[0].element["resource-id"]).toBeUndefined();
  expect(result.selectedMatch?.resourceId).toBe("row");
  expect(result.nearMisses?.some((match) => match.value === "Save") ?? false).toBe(false);
});

test("debug text containers retain contains matching before a later exact peer", async () => {
  const feature = search(
    capture(
      { text: "Settings panel", children: [{ bounds, text: "Ready", "resource-id": "status" }] },
      { text: "Settings" },
    ),
  );
  const result = await feature.execute({ resourceId: "status", container: { text: "Settings" } });
  expect(result.matches).toHaveLength(1);
  expect(result.matches[0].resourceId).toBe("status");
});

test("debug excludes every matching descendant merged into one action row from near misses", async () => {
  const feature = search(
    capture({
      "resource-id": "row",
      children: [
        { text: "Save", bounds: { left: 1, top: 1, right: 10, bottom: 10 } },
        { "content-desc": "Save", bounds: { left: 11, top: 1, right: 19, bottom: 10 } },
      ],
    }),
  );
  const result = await feature.execute({ text: "Save" });
  expect(result.matches).toHaveLength(1);
  expect(result.matches[0].matchedProperties).toEqual(["text", "content-desc"]);
  expect(result.matches[0].matchedValue).toBe("Save");
  expect(result.nearMisses ?? []).toHaveLength(0);
});

test("debug selected diagnostics map eligible candidates back to the full match list", async () => {
  const result = await search(
    capture(
      { text: "Save", clickable: false },
      { "content-desc": "Save", "resource-id": "button" },
    ),
  ).execute({ text: "Save" });
  expect(result.matches).toHaveLength(2);
  expect(result.selectedMatch?.resourceId).toBe("button");
  expect(result.selectedMatch?.matchedProperties).toEqual(["content-desc"]);
  expect(result.nearMisses ?? []).toHaveLength(0);
});
