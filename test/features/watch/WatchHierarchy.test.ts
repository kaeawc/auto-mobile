import { expect, test } from "bun:test";
import { normalizeWatchHierarchy } from "../../../src/features/watch/WatchHierarchy";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import hierarchy from "../../fixtures/watchos-xcuitest/hierarchy.json";

test("normalizes the captured watch tree through the iOS observation model", () => {
  const normalized = normalizeWatchHierarchy(hierarchy);
  expect(normalized.screenWidth).toBe(208);
  expect(normalized.screenHeight).toBe(248);
  const elements = new DefaultElementParser()
    .flattenViewHierarchy(normalized)
    .map((entry) => entry.element);
  expect(elements.find((element) => element["resource-id"] === "tapme")).toMatchObject({
    text: "Tap me",
    class: "XCUIElementTypeButton",
    clickable: "true",
    bounds: { left: 15, top: 78.5, right: 193, bottom: 131 },
  });
  expect(elements.find((element) => element.text === "row 0")).toMatchObject({
    bounds: { left: 82.5, top: 168.8, right: 125.5, bottom: 189.3 },
  });
});
test("rejects malformed SDK trees instead of inventing defaults", () => {
  expect(() => normalizeWatchHierarchy({ children: [] })).toThrow("invalid hierarchy");
});
