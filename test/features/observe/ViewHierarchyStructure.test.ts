import { expect, test } from "bun:test";
import { ViewHierarchy } from "../../../src/features/observe/ViewHierarchy";

const subject = Object.create(ViewHierarchy.prototype) as ViewHierarchy;
const stringKeys = [
  "resourceId",
  "resource-id",
  "viewId",
  "view-id",
  "text",
  "contentDesc",
  "content-desc",
  "test-tag",
  "role",
  "state-description",
  "error-message",
  "hint-text",
  "tooltip-text",
  "pane-title",
  "live-region",
  "collection-info",
  "collection-item-info",
  "range-info",
  "input-type",
];

test("every meaningful string attribute retains current truthiness semantics", () => {
  for (const key of stringKeys) {
    for (const value of ["label", " ", "false", true, 1, {}]) {
      expect(subject.meetsStringFilterCriteria({ [key]: value })).toBe(true);
    }
    for (const value of ["", false, 0, null, undefined]) {
      expect(subject.meetsStringFilterCriteria({ [key]: value })).toBe(false);
    }
  }
  expect(subject.meetsStringFilterCriteria({ recomposition: {} })).toBe(true);
  expect(subject.meetsStringFilterCriteria({ recompositionMetrics: {} })).toBe(true);
});

test("string filtering short circuits and reads the matching value twice", () => {
  const reads: string[] = [];
  const props = new Proxy(
    { resourceId: "first", text: "later" },
    {
      get(target, key, receiver) {
        reads.push(String(key));
        return Reflect.get(target, key, receiver);
      },
    },
  );
  expect(subject.meetsStringFilterCriteria(props)).toBe(true);
  expect(reads).toEqual(["resourceId", "resourceId"]);
});

test("attribute bags normalize aliases and preserve extras after cleaned keys", () => {
  const source = {
    $: {
      resourceId: "first",
      "resource-id": "last",
      contentDesc: "label",
      enabled: true,
      clickable: "false",
      text: "",
      selected: true,
      bounds: null,
      unknown: "discard",
    },
    extras: { retained: "yes" },
    windowId: 2,
    node: [{ text: "child" }],
  };
  expect(JSON.stringify(subject.cleanNodeProperties(source))).toBe(
    '{"resource-id":"last","content-desc":"label","selected":true,"bounds":null,"extras":{"retained":"yes"},"windowId":2}',
  );
});

test("flat attributes retain aliases and omit defaults without dropping null", () => {
  expect(
    JSON.stringify(
      subject.cleanNodeProperties({
        resourceId: "id",
        contentDesc: "label",
        text: "false",
        enabled: false,
        clickable: false,
        bounds: null,
        unknown: "discard",
        node: [],
      }),
    ),
  ).toBe('{"resourceId":"id","contentDesc":"label","enabled":false,"bounds":null}');
});

test("child filtering flattens promoted nodes in callback order", () => {
  const children = [{ text: "first" }, { text: "discard" }, { text: "last" }];
  const visited: string[] = [];
  expect(
    subject.processNodeChildren({ node: children }, (child) => {
      visited.push(child.text);
      return child.text === "discard" ? null : [child, child];
    }),
  ).toEqual([children[0], children[0], children[2], children[2]]);
  expect(visited).toEqual(["first", "discard", "last"]);
  expect(
    subject.processNodeChildren({}, () => {
      throw new Error("no children");
    }),
  ).toEqual([]);
});
