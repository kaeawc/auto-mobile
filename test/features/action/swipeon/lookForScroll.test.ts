import { expect, test } from "bun:test";
import type { Element, ObserveResult } from "../../../../src/models";
import {
  containerContentSignature,
  itemsStayed,
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
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    updatedAt: 0,
    observationId: "test-observation",
    display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
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

function formObservation(values: string[]): ObserveResult {
  const page = observation([]);
  const root = page.viewHierarchy?.hierarchy.node as Element & { node?: unknown };
  root.node = values.map((value, i) => ({
    text: "Name",
    "resource-id": "field",
    class: "android.widget.EditText",
    value,
    bounds: { left: 0, top: i * 100, right: 400, bottom: (i + 1) * 100 },
  }));
  return page;
}

test("itemsStayed tells reused-ID form rows apart by their editable value", () => {
  const previous = {
    container,
    signature: containerContentSignature(formObservation(["Ann", "Bob"]), container),
  };
  expect(previous.signature).not.toBe("");
  expect(itemsStayed(previous, formObservation(["Cy", "Di"]))).toBe(false);
  expect(itemsStayed(previous, formObservation(["Ann", "Bob"]))).toBe(true);
});

function fieldsObservation(fields: Array<Record<string, string>>): ObserveResult {
  const page = observation([]);
  const root = page.viewHierarchy?.hierarchy.node as Element & { node?: unknown };
  root.node = fields.map((field, i) => ({
    ...field,
    bounds: { left: 0, top: i * 100, right: 400, bottom: (i + 1) * 100 },
  }));
  return page;
}

test("itemsStayed tells reused-ID iOS fields apart by their placeholder", () => {
  const field = (hint: string) => ({
    "resource-id": "field",
    "ios-accessibility-label": "Field",
    class: "UITextField",
    value: "",
    "hint-text": hint,
  });
  const previous = {
    container,
    signature: containerContentSignature(
      fieldsObservation([field("First name"), field("Last name")]),
      container,
    ),
  };
  expect(itemsStayed(previous, fieldsObservation([field("Street"), field("City")]))).toBe(false);
  expect(itemsStayed(previous, fieldsObservation([field("First name"), field("Last name")]))).toBe(
    true,
  );
});

test("value-only editable rows reach the signature but not the overlap keys", () => {
  const field = (value: string) => ({ class: "android.widget.EditText", value });
  const page = fieldsObservation([field("Ann"), field("Bob")]);
  const previous = { container, signature: containerContentSignature(page, container) };
  expect(previous.signature).not.toBe("");
  expect(visibleScrollKeys(page, container).size).toBe(0);
  expect(itemsStayed(previous, fieldsObservation([field("Cy"), field("Di")]))).toBe(false);
  expect(itemsStayed(previous, fieldsObservation([field("Ann"), field("Bob")]))).toBe(true);
});
