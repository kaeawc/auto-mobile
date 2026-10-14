import { beforeAll, expect, test } from "bun:test";
import {
  prototypeSearchBarFields,
  prototypeSearchBarUnsupportedMessage,
} from "../../../src/features/prototype/prototypeSearchBar";
import {
  prototypeSpecSchema,
  type PrototypeSpec,
} from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypePlatformNotes } from "../../../src/features/prototype/prototypePlatformNotes";

const spec = {
  id: "search",
  window: { placement: { type: "fullscreen" as const } },
  state: { query: "", active: true },
  root: {
    type: "searchBar" as const,
    stateKey: "query",
    activeKey: "active",
    leadingIcon: "search",
    trailingActions: [
      { icon: "close", label: "Clear", onTap: [{ type: "setState", key: "query", value: "" }] },
    ],
    onSubmit: [{ type: "emit", name: "submit" }],
    child: {
      type: "column" as const,
      children: [{ type: "searchBar" as const, stateKey: "query" }],
    },
  },
};
beforeAll(() => {
  validatePrototypeSpec(spec);
  prototypeSpecSchema.safeParse(spec);
});

test("fields identify nodes depth-first through both child slots without mutating the spec", () => {
  const before = JSON.stringify(spec);
  expect(prototypeSearchBarFields(spec as PrototypeSpec)).toEqual([
    "root",
    "root.child.children[0]",
  ]);
  expect(prototypeSearchBarFields({ ...spec, root: { type: "text", text: "searchBar" } })).toEqual(
    [],
  );
  expect(JSON.stringify(spec)).toBe(before);
});

test("fields return empty for malformed specs and skip malformed children", () => {
  for (const malformed of [
    { root: null },
    { root: "x" },
    { root: { type: "column", children: "x" } },
    { root: { type: "column", children: [null] } },
    { root: { type: "column", child: 5 } },
  ]) {
    expect(prototypeSearchBarFields(malformed)).toEqual([]);
  }
});

test.each(["android", "ios"] as const)(
  "%s refusal names capability, first path, count and update",
  (platform) => {
    const message = prototypeSearchBarUnsupportedMessage(
      ["root.child", "root.children[1]"],
      platform,
    );
    expect(message).toContain("prototype_search_bar_v1");
    expect(message).toContain("root.child (and 1 more)");
    expect(message).toContain("Nothing was shown");
    expect(message).toContain(platform === "ios" ? "Relaunch" : "Update");
    expect(prototypeSearchBarUnsupportedMessage(["root"], platform)).not.toContain("more");
  },
);

test("searchBar state, child and action validation walk the ordinary subtree", () => {
  expect(validatePrototypeSpec(spec).success).toBe(true);
  for (const [field, actions] of [
    ["onSubmit", [{ type: "setState", key: "bad key", value: "" }]],
    ["onSubmit", [{ type: "setState", key: "active", value: "bad" }]],
    ["onSubmit", [{ type: "toggle", key: "query" }]],
  ] as const) {
    expect(
      validatePrototypeSpec({ ...spec, root: { ...spec.root, [field]: actions } }).success,
    ).toBe(false);
  }
  expect(
    validatePrototypeSpec({
      ...spec,
      root: {
        ...spec.root,
        trailingActions: [
          { icon: "close", label: "Clear", onTap: [{ type: "increment", key: "query" }] },
        ],
      },
    }).success,
  ).toBe(false);
  expect(
    validatePrototypeSpec({
      ...spec,
      root: { ...spec.root, child: { type: "textField", stateKey: "missing" } },
    }).success,
  ).toBe(false);
  expect(validatePrototypeSpec({ ...spec, root: { ...spec.root, child: undefined } }).success).toBe(
    false,
  );
  const withoutChild = { ...spec.root } as Partial<typeof spec.root>;
  delete withoutChild.child;
  expect(validatePrototypeSpec({ ...spec, root: withoutChild }).success).toBe(true);
  const withoutActive = { ...spec.root } as Partial<typeof spec.root>;
  delete withoutActive.activeKey;
  expect(validatePrototypeSpec({ ...spec, root: withoutActive }).success).toBe(false);
});

test("iOS notes describe the drawn field and SF Symbol search icons", () => {
  const notes = prototypePlatformNotes(spec as PrototypeSpec, "ios", () => true);
  expect(notes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        construct: "searchBar",
        paths: ["root", "root.child.children[0]"],
      }),
      expect.objectContaining({
        construct: "searchBar.icons",
        paths: ["root.leadingIcon", "root.trailingActions[0].icon"],
      }),
    ]),
  );
  expect(prototypePlatformNotes(spec as PrototypeSpec, "android", () => true)).toEqual([]);
});
