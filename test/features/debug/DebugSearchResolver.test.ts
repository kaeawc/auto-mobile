import { expect, test } from "bun:test";
import { DebugSearch } from "../../../src/features/debug/DebugSearch";
import type { BootedDevice, ViewHierarchyResult } from "../../../src/models";
const bounds = { left: 0, top: 0, right: 20, bottom: 20 };
const search = (capture: ViewHierarchyResult) =>
  new DebugSearch(
    { platform: "android" } as BootedDevice,
    undefined,
    undefined,
    undefined,
    undefined,
    { getViewHierarchy: async () => capture },
  );
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
test("debug selection follows tap eligibility and missing containers never search globally", async () => {
  const feature = search(capture({ text: "Save", clickable: false }, { text: "Save" }));
  const result = await feature.execute({ text: "Save" });
  expect(result.matches).toHaveLength(2);
  expect(result.selectedMatch).toBe(result.matches[1]);
  expect(
    (await feature.execute({ text: "Save", container: { elementId: "missing" } })).matches,
  ).toHaveLength(0);
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
