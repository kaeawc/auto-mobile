import { expect, test } from "bun:test";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import { FakeTimer } from "../../fakes/FakeTimer";
import { DebugSearch } from "../../../src/features/debug/DebugSearch";
import type { BootedDevice, ViewHierarchyResult } from "../../../src/models";
import { createDeviceHierarchyCapture } from "../../../src/features/observe/DeviceHierarchyCapture";
import {
  normalizeIosHierarchy,
  projectActionableHierarchy,
} from "../../../src/features/observe/HierarchyNormalization";
import { identifyObservedHierarchy } from "../../../src/features/observe/HierarchyCapture";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { serverConfig } from "../../../src/utils/ServerConfig";
import { iosProjectionFixture } from "../../fixtures/iosProjectionFixture";
const bounds = { left: 0, top: 0, right: 20, bottom: 20 };

test("iOS debug and action candidates use observe's cleaned visible bounds in raw mode", async () => {
  const source = iosProjectionFixture();
  const device: BootedDevice = { platform: "ios", deviceId: "fixture", name: "fixture" };
  const timer = new FakeTimer();
  const capture = createDeviceHierarchyCapture(device, {
    timer,
    syncClientFactory: () => ({
      requestHierarchySync: async () => ({ hierarchy: source }),
      convertToViewHierarchyResult: () => source,
    }),
  });
  const observed = projectActionableHierarchy("ios", normalizeIosHierarchy(source));
  const observedNodes = identifyObservedHierarchy("ios", observed, "fresh", timer).nodes;
  const selector = new ResolverElementSelector();
  serverConfig.setRawElementSearchEnabled(true);
  try {
    const snapshot = await capture.capture({ freshness: "fresh", searchRaw: true });
    const candidates = (nodes: typeof observedNodes) =>
      nodes.filter((node) => node.nativeId).map((node) => [node.nativeId, node.bounds]);
    expect(candidates(snapshot.nodes)).toEqual(candidates(observedNodes));
    expect(snapshot.nodes.some((node) => node.className === "WKWebView")).toBe(false);
    expect(candidates(snapshot.nodes)).toEqual([
      ["source-id", { left: 10, top: 10, right: 30, bottom: 30 }],
      ["target-id", { left: 60, top: 60, right: 80, bottom: 80 }],
    ]);
    expect(selector.selectByResourceId(observed, "source-id").element?.bounds).toEqual(
      selector.selectByResourceId(snapshot.hierarchy, "source-id").element?.bounds,
    );
    expect(selector.selectByResourceId(snapshot.hierarchy, "hidden-id").element).toBeNull();
    const debug = new DebugSearch(device, undefined, timer, undefined, capture);
    for (const elementId of ["source-id", "target-id"]) {
      const result = await debug.execute({ resourceId: elementId });
      expect(result.matches.map((match) => [match.resourceId, match.element.bounds])).toEqual(
        candidates(observedNodes).filter(([id]) => id === elementId),
      );
    }
    expect((await debug.execute({ resourceId: "hidden-id" })).matches).toEqual([]);
    expect((await debug.execute({ text: "Source" })).matches).toHaveLength(1);
  } finally {
    serverConfig.setRawElementSearchEnabled(false);
  }
});
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
  expect(result.matches[0].element.bounds).toEqual({ left: 1, top: 1, right: 10, bottom: 10 });
  expect(result.selectedMatch?.element.bounds).toEqual(bounds);
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
  expect(result.matches[0].element.bounds).toEqual({ left: 1, top: 1, right: 10, bottom: 10 });
  expect(result.selectedMatch?.element.bounds).toEqual(bounds);
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
