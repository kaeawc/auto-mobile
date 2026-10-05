import { expect, test } from "bun:test";
import type { Element, ObserveResult } from "../../../../src/models";
import {
  recoverLookForOverlap,
  visibleScrollKeys,
} from "../../../../src/features/action/swipeon/lookForScroll";
import { FakeTimer } from "../../../fakes/FakeTimer";

const container = {
  "resource-id": "list",
  scrollable: true,
  bounds: { left: 0, top: 0, right: 400, bottom: 900 },
} as Element;
function observation(texts: string[]): ObserveResult {
  return {
    timestamp: 0,
    screenSize: { width: 400, height: 900 },
    viewHierarchy: {
      hierarchy: {
        node: {
          ...container,
          node: texts.map((text, i) => ({
            text,
            "resource-id": "row",
            bounds: { left: 0, top: i * 100, right: 400, bottom: (i + 1) * 100 },
          })),
        },
      },
    },
  };
}

test("review: duplicate identities retain shared presence", () => {
  const before = visibleScrollKeys(observation(["Buy"]), container);
  const after = visibleScrollKeys(observation(["Buy", "Buy"]), container);
  expect([...before.keys()].every((key) => after.has(key))).toBe(true);
});

test("review: overlap guard requires enough distinct keys in both observations", async () => {
  const previous = observation(["a", "b", "c", "d", "e", "f"]);
  const next = observation(["large card"]);
  let backwards = 0;
  const result = await recoverLookForOverlap({
    previousKeys: visibleScrollKeys(previous, container),
    observation: next,
    keys: async (page) => visibleScrollKeys(page, container),
    backScroll: async () => {
      backwards++;
      return previous;
    },
    timer: new FakeTimer(),
    deadline: 15000,
  });
  expect(backwards).toBe(0);
  expect(result).toBe(next);
});

test("review: dense pages overlap through a key duplicated in the second page", async () => {
  const before = observation(["Buy", "a", "b", "c", "d"]);
  const after = observation(["Buy", "Buy", "e", "f", "g", "h"]);
  let backwards = 0;
  expect(
    await recoverLookForOverlap({
      previousKeys: visibleScrollKeys(before, container),
      observation: after,
      keys: async (page) => visibleScrollKeys(page, container),
      backScroll: async () => {
        backwards++;
        return before;
      },
      timer: new FakeTimer(),
      deadline: 15000,
    }),
  ).toBe(after);
  expect(backwards).toBe(0);
});
