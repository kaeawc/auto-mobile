import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  repeatErrors,
  repeatFieldReferences,
} from "../../../src/features/prototype/prototypeRepeat";
import {
  BOUND_STATE_KEY_PATTERN,
  bindNodeFields,
} from "../../../src/features/prototype/prototypeTemplate";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const spec = (root: unknown) => ({
  id: "r",
  window: { placement: { type: "fullscreen" } },
  root,
});
const list = (children: unknown[], items: unknown[] = [{ a: 1 }], as = "item") => ({
  type: "column",
  repeat: { items, as },
  children,
});

describe("repeatFieldReferences", () => {
  test("finds only the declared alias, in order, and ignores index and other braces", () => {
    expect(
      repeatFieldReferences("{index} {item.a} {x.b} {item} {item.} {{item.c}} {item.d", "item"),
    ).toEqual(["a", "c"]);
  });
  test("an alias is matched exactly, not by prefix", () => {
    expect(repeatFieldReferences("{items.a} {it.a}", "item")).toEqual([]);
  });
  test("over-long field names stay literal", () => {
    expect(repeatFieldReferences(`{item.${"a".repeat(65)}}`, "item")).toEqual([]);
  });
});

describe("repeatErrors", () => {
  test("searchBar binds placeholder, result child, trailing labels and actions", () => {
    const search = {
      type: "searchBar",
      stateKey: "query_{item.x}",
      activeKey: "active_{item.x}",
      placeholder: "Find {item.x}",
      trailingActions: [
        {
          icon: "close",
          label: "Clear {item.x}",
          onTap: [{ type: "setState", key: "query_{item.x}", value: "" }],
        },
      ],
      onSubmit: [{ type: "emit", name: "submit_{item.x}" }],
      child: { type: "text", text: "Result {item.x}" },
    };
    const candidate = {
      ...spec(list([search], [{ x: "one" }])),
      state: { query_one: "", active_one: true },
    };
    expect(validatePrototypeSpec(candidate).success).toBe(true);
    const instance = { binding: { alias: "item", index: true }, values: { x: "one" }, index: 0 };
    expect(bindNodeFields(search, "root.children[0]", instance)).toMatchObject({
      stateKey: "query_one",
      activeKey: "active_one",
      placeholder: "Find one",
      trailingActions: [{ label: "Clear one", onTap: [{ key: "query_one" }] }],
      onSubmit: [{ name: "submit_one" }],
    });
    expect(bindNodeFields(search.child, "root.children[0].child", instance)).toMatchObject({
      text: "Result one",
    });
    for (const [field, node] of [
      ["placeholder", { ...search, placeholder: "{item.nope}" }],
      [
        "trailingActions[0].label",
        { ...search, trailingActions: [{ icon: "close", label: "{item.nope}" }] },
      ],
      ["child.text", { ...search, child: { type: "text", text: "{item.nope}" } }],
      ["onSubmit[0].name", { ...search, onSubmit: [{ type: "emit", name: "{item.nope}" }] }],
    ] as const) {
      expect(repeatErrors({ ...candidate, root: list([node], [{ x: "one" }]) })?.path).toBe(
        `root.children[0].${field}`,
      );
    }
  });
  test("specs without repeat have no repeat errors", () => {
    expect(repeatErrors(spec({ type: "spacer" }))).toBeUndefined();
    expect(repeatErrors("not a spec")).toBeUndefined();
  });
  test("placeholders outside a template stay literal", () => {
    expect(repeatErrors(spec({ type: "text", text: "{item.nope}" }))).toBeUndefined();
  });
  test("the repeat container's own fields are outside the template scope", () => {
    const root = {
      ...list([{ type: "spacer" }]),
      visibleWhen: { key: "k", equals: "{item.nope}" },
    };
    expect(repeatErrors(spec(root))).toBeUndefined();
  });
  test("templates nested under scroll and sheets are checked at their child path", () => {
    const root = list([{ type: "scroll", child: { type: "text", text: "{item.zzz}" } }]);
    expect(repeatErrors(spec(root))?.path).toBe("root.children[0].child.text");
  });
  test("expansion multiplies the template, not the container", () => {
    const items = Array.from({ length: 10 }, (_, n) => ({ n }));
    const spacers = (count: number) => Array.from({ length: count }, () => ({ type: "spacer" }));
    // 1 container + 10 * 49 = 1991 nodes fits; 10 * 200 = 2000 + 1 does not.
    expect(repeatErrors(spec(list(spacers(199), items)))).toBeUndefined();
    expect(repeatErrors(spec(list(spacers(200), items)))).toEqual({
      path: "root.repeat",
      message: "Expanded node limit exceeded",
    });
  });
  test("an emit name that expands to empty for any item is rejected at the name", () => {
    const emit = (name: string) => ({ type: "text", text: "x", onTap: [{ type: "emit", name }] });
    const items = [{ id: "a" }, { id: "" }];
    expect(repeatErrors(spec(list([emit("{item.id}")], items)))).toEqual({
      path: "root.children[0].onTap[0].name",
      message: "Expanded emit name is empty for item 1",
    });
    expect(repeatErrors(spec(list([emit("row-{item.id}")], items)))).toBeUndefined();
    expect(repeatErrors(spec(list([emit("{index}")], items)))).toBeUndefined();
  });
  test("component labels, titles and button actions bind and are checked per field", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../../fixtures/prototype-spec/valid/repeat-component-labels.json"),
        "utf8",
      ),
    );
    expect(validatePrototypeSpec(fixture).success).toBe(true);
    const cases: [Record<string, unknown>, string][] = [
      [{ type: "button", label: "{item.zz}" }, "root.children[0].label"],
      [{ type: "fab", icon: "add", label: "{item.zz}" }, "root.children[0].label"],
      [
        {
          type: "segmentedButton",
          stateKey: "k",
          options: [
            { value: "a", label: "ok" },
            { value: "b", label: "{item.zz}" },
          ],
        },
        "root.children[0].options[1].label",
      ],
      [{ type: "topAppBar", title: "{item.zz}" }, "root.children[0].title"],
      [
        { type: "topAppBar", title: "t", actions: [{ icon: "add", label: "{item.zz}" }] },
        "root.children[0].actions[0].label",
      ],
      [
        {
          type: "topAppBar",
          title: "t",
          navigationIcon: {
            icon: "add",
            label: "x",
            onTap: [{ type: "setState", key: "k", value: "{item.zz}" }],
          },
        },
        "root.children[0].navigationIcon.onTap[0].value",
      ],
      [
        {
          type: "dialog",
          openWhen: { key: "k", equals: true },
          confirm: { label: "x" },
          dismiss: { label: "{item.zz}" },
        },
        "root.children[0].dismiss.label",
      ],
      [
        { type: "snackbar", openWhen: { key: "k", equals: true }, text: "{item.zz}" },
        "root.children[0].text",
      ],
      [
        {
          type: "snackbar",
          openWhen: { key: "k", equals: true },
          text: "t",
          action: { label: "{item.zz}" },
        },
        "root.children[0].action.label",
      ],
    ];
    for (const [node, path] of cases) {
      expect(repeatErrors(spec(list([node])))).toEqual({
        path,
        message: 'Unknown repeat field "zz"',
      });
    }
  });
  test("tab item images in a template count once per instance", () => {
    const nav = { type: "tabBar", stateKey: "t", items: [{ label: "a", image: "x" }] };
    const items = Array.from({ length: 33 }, (_, n) => ({ n }));
    expect(repeatErrors(spec(list([nav], items.slice(0, 32))))).toBeUndefined();
    expect(repeatErrors(spec(list([nav, nav], items.slice(0, 17))))).toEqual({
      path: "root.repeat",
      message: "Expanded image limit exceeded",
    });
  });
  test("instances are siblings, so a template at the depth limit still fits", () => {
    let node: unknown = list([{ type: "spacer" }], [{ a: 1 }, { a: 2 }]);
    for (let depth = 1; depth < 23; depth++) {
      node = { type: "box", children: [node] };
    }
    // The repeat container sits at depth 23, its instances at depth 24.
    expect(validatePrototypeSpec(spec(node)).success).toBe(true);
    expect(validatePrototypeSpec(spec({ type: "box", children: [node] })).success).toBe(false);
  });
});

test("the public schema constrains repeat items to flat scalar maps", () => {
  const repeatItems = (value: unknown) =>
    validatePrototypeSpec(
      spec({
        type: "column",
        repeat: { items: [value], as: "item" },
        children: [{ type: "spacer" }],
      }),
    );
  expect(repeatItems({ a: 1, b: "x", c: true }).success).toBe(true);
  for (const bad of [[1], null, { nested: { a: 1 } }, { "bad key": 1 }, { list: [1] }]) {
    expect(repeatItems(bad).success).toBe(false);
  }
});

test("the documented repeat snippet is a valid spec root", () => {
  const document = readFileSync(
    join(import.meta.dir, "../../../docs/design-docs/plat/android/prototype-ux.md"),
    "utf8",
  ).replace(/\r\n/g, "\n"); // Windows checkouts may convert the doc to CRLF
  const section = document.split("### List templates: repeat")[1];
  const snippet = section.split("```json\n")[1].split("```")[0];
  const result = validatePrototypeSpec({ ...spec(JSON.parse(snippet)), state: { picked: "a" } });
  expect(result.success).toBe(true);
});

describe("bound state keys (#11051)", () => {
  test("take placeholders and reject any other brace text, as Kotlin isBoundKey does", () => {
    for (const key of ["liked", "liked_{item.id}", "{index}_{props.k}", "9_{item.id}"]) {
      expect(BOUND_STATE_KEY_PATTERN.test(key)).toBe(true);
    }
    for (const key of ["9a", "", "liked_{item}", "liked-{item.id}", "liked_{item.id", "{}"]) {
      expect(BOUND_STATE_KEY_PATTERN.test(key)).toBe(false);
    }
  });
  const toggle = (key: string) => ({
    type: "text",
    text: "Like",
    onTap: [{ type: "toggle", key }],
  });
  const keyed = (key: string, items: unknown[], state: Record<string, unknown>) => ({
    ...spec(list([toggle(key)], items)),
    state,
  });
  test("a key bound per item is type-checked per item and names the item", () => {
    const state = { liked_a: false, liked_b: true };
    expect(
      validatePrototypeSpec(keyed("liked_{item.id}", [{ id: "a" }, { id: "b" }], state)),
    ).toMatchObject({
      success: true,
    });
    expect(
      validatePrototypeSpec(keyed("liked_{item.id}", [{ id: "a" }, { id: "c" }], state)),
    ).toEqual({
      success: false,
      error: {
        path: "root.children[0].onTap[0].key",
        message: "Toggle requires a boolean state key (repeat item 1)",
      },
    });
  });
  test("a key that binds to an invalid key fails at the item", () => {
    expect(repeatErrors(keyed("k{index}_{item.id}", [{ id: "a" }, { id: 1.5 }], {}))).toEqual({
      path: "root.repeat.items[1]",
      message: 'Bound state key "k1_1.5" is invalid',
    });
  });
  test("a placeholder for another alias or outside every template is not a key", () => {
    expect(repeatErrors(keyed("liked_{row.id}", [{ id: "a" }], {}))?.path).toBe(
      "root.children[0].onTap[0].key",
    );
    expect(repeatErrors(spec(toggle("liked_{item.id}")))).toEqual({
      path: "root.onTap[0].key",
      message: "State key placeholder outside a repeat template",
    });
  });
});

describe("data-bound repeats", () => {
  const dataSpec = (
    items: unknown,
    extra: Record<string, unknown> = {},
    children: unknown[] = [{ type: "text", text: "{item.title}" }],
  ) => ({
    ...spec({
      type: "column",
      repeat: { items: { path: "/orders" }, as: "item", ...extra },
      children,
    }),
    data: { orders: items },
  });
  test.each([
    [undefined, "Repeat path does not resolve to an array"],
    [1, "Repeat path does not resolve to an array"],
    [
      Array.from({ length: 129 }, () => ({ title: "x" })),
      "Repeat path resolves to more than 128 items",
    ],
    [[{ title: "x" }, 1], "Repeat path item 1 is not an object"],
  ])("path resolution %p", (items, message) => {
    expect(repeatErrors(dataSpec(items))).toEqual({ path: "root.repeat.items.path", message });
  });
  test("empty arrays instantiate zero children", () => {
    expect(validatePrototypeSpec(dataSpec([]))).toMatchObject({ success: true });
  });
  test("key fields must exist after projection; duplicates use rendered text", () => {
    expect(repeatErrors(dataSpec([{ title: "a", id: {} }], { key: "id" }))).toEqual({
      path: "root.repeat.key",
      message: 'Unknown repeat field "id"',
    });
    expect(
      repeatErrors(
        dataSpec(
          [
            { title: "a", id: 7 },
            { title: "b", id: "7" },
          ],
          { key: "id" },
        ),
      ),
    ).toEqual({ path: "root.repeat.key", message: 'Duplicate repeat key "7" (items 0 and 1)' });
    expect(repeatErrors(spec(list([{ type: "spacer" }], [{ id: 1 }, { id: 1 }])))).toBeUndefined();
    const literal = {
      ...list([{ type: "spacer" }], [{ id: 1 }, { id: 1 }]),
      repeat: { as: "item", items: [{ id: 1 }, { id: 1 }], key: "id" },
    };
    expect(repeatErrors(spec(literal))).toEqual({
      path: "root.repeat.key",
      message: 'Duplicate repeat key "1" (items 0 and 1)',
    });
  });
  test("path-bound invalid keys have a path location and item suffix; literals keep their location", () => {
    const child = { type: "switch", stateKey: "liked_{item.id}" };
    expect(repeatErrors(dataSpec([{ id: "bad-key" }], {}, [child]))).toEqual({
      path: "root.repeat.items.path",
      message: 'Bound state key "liked_bad-key" is invalid (repeat item 0)',
    });
    expect(repeatErrors(spec(list([child], [{ id: "bad-key" }])))).toEqual({
      path: "root.repeat.items[0]",
      message: 'Bound state key "liked_bad-key" is invalid',
    });
    expect(validatePrototypeSpec(dataSpec([{ id: 7 }], {}, [child]))).toEqual({
      success: false,
      error: {
        path: "root.children[0].stateKey",
        message: "Toggle control requires a boolean state key (repeat item 0)",
      },
    });
  });
  test("non-scalar item members are absent to templates", () => {
    expect(repeatErrors(dataSpec([{ title: { text: "a" } }]))).toEqual({
      path: "root.children[0].text",
      message: 'Unknown repeat field "title"',
    });
  });
  test("path-bound expansion overflow points to the repeat", () => {
    expect(
      repeatErrors(
        dataSpec(
          Array.from({ length: 128 }, () => ({})),
          {},
          Array.from({ length: 16 }, () => ({ type: "spacer" })),
        ),
      ),
    ).toEqual({ path: "root.repeat", message: "Expanded node limit exceeded" });
  });
  test.each(["equals", "notEquals"])(
    "data %s operands cannot contain repeat placeholders",
    (comparison) => {
      const child = {
        type: "text",
        text: "x",
        visibleWhen: { data: "/n", [comparison]: "{item.id}" },
      };
      expect(repeatErrors(dataSpec([{ id: 7 }], {}, [child]))).toEqual({
        path: `root.children[0].visibleWhen.${comparison}`,
        message: "Repeat placeholder in a data condition operand is not supported",
      });
      expect(
        repeatErrors(
          dataSpec([{ id: 7 }], {}, [
            { ...child, visibleWhen: { key: "n", [comparison]: "{item.id}" } },
          ]),
        ),
      ).toBeUndefined();
      expect(
        repeatErrors(
          dataSpec([{ id: 7 }], {}, [
            { ...child, visibleWhen: { data: "/n", [comparison]: "{index}" } },
          ]),
        )?.message,
      ).toBe("Repeat placeholder in a data condition operand is not supported");
    },
  );
  test("data operands are checked in the bindable walk order", () => {
    const child = {
      type: "text",
      text: "{item.missing}",
      visibleWhen: { data: "/n", equals: "{index}" },
    };
    expect(repeatErrors(dataSpec([{}], {}, [child]))).toEqual({
      path: "root.children[0].text",
      message: 'Unknown repeat field "missing"',
    });
  });
});

describe("substituted text length", () => {
  const error = (path: string) => ({
    success: false,
    error: { path, message: "Substituted text length limit exceeded" },
  });
  const text = (value: string) => ({ type: "text", text: value });
  test("data amplification is rejected without building the replacement", () => {
    const input = { ...spec(text("{data:/b}".repeat(80_000))), data: { b: "x".repeat(200_000) } };
    expect(validatePrototypeSpec(input)).toEqual(error("root.text"));
  });
  test.each([16_384, 16_385])("data boundary %i", (length) => {
    const input = { ...spec(text("{data:/b}")), data: { b: "x".repeat(length) } };
    expect(validatePrototypeSpec(input)).toEqual(
      length === 16_384 ? expect.objectContaining({ success: true }) : error("root.text"),
    );
  });
  test.each([
    ["text", text("{item.b}{item.b}"), "text"],
    [
      "emit",
      { ...text("tap"), onTap: [{ type: "emit", name: "{item.b}{item.b}" }] },
      "onTap[0].name",
    ],
    [
      "operand",
      { ...text("tap"), onTap: [{ type: "setState", key: "k", value: "{item.b}{item.b}" }] },
      "onTap[0].value",
    ],
  ] as const)("repeat %s is capped", (_name, child, field) => {
    expect(
      validatePrototypeSpec({
        ...spec(list([child], [{ b: "x".repeat(8193) }])),
        state: { k: "" },
      }),
    ).toEqual(error(`root.children[0].${field}`));
  });
  test("repeat key amplification uses the fixed error before binding", () => {
    const child = { ...text("tap"), onTap: [{ type: "toggle", key: "{item.b}".repeat(2000) }] };
    expect(validatePrototypeSpec(spec(list([child], [{ b: "x".repeat(100_000) }])))).toEqual(
      error("root.children[0].onTap[0].key"),
    );
  });
  test("repeat counts index and each item's own rendered length", () => {
    expect(
      validatePrototypeSpec(
        spec(
          list(
            [text("{index}".repeat(8193))],
            Array.from({ length: 11 }, () => ({})),
          ),
        ),
      ),
    ).toEqual(error("root.children[0].text"));
    expect(
      validatePrototypeSpec(
        spec(list([text("{item.b}{item.b}")], [{ b: "s" }, { b: "x".repeat(8193) }])),
      ),
    ).toEqual(error("root.children[0].text"));
  });
  test("data cascades into repeat and path items use the same bound", () => {
    const root = list([text("{data:/t}")], [{ b: "x".repeat(8193) }]);
    expect(validatePrototypeSpec({ ...spec(root), data: { t: "{item.b}{item.b}" } })).toEqual(
      error("root.children[0].text"),
    );
    expect(
      validatePrototypeSpec({
        ...spec({
          ...root,
          repeat: { items: { path: "/rows" }, as: "item" },
          children: [text("{item.b}{item.b}")],
        }),
        data: { rows: [{ b: "x".repeat(8193) }] },
      }),
    ).toEqual(error("root.children[0].text"));
  });
  test("literal characters and mutable state replacements do not count", () => {
    for (const input of [
      spec(text("x".repeat(20_000))),
      { ...spec(text("x".repeat(20_000) + "{data:/s}")), data: { s: "short" } },
      { ...spec(text("{b}".repeat(1000))), state: { b: "x".repeat(100_000) } },
    ]) {
      expect(validatePrototypeSpec(input).success).toBe(true);
    }
  });
  test("unknown authored repeat fields win before the length error", () => {
    expect(
      validatePrototypeSpec({
        ...spec(list([text("{item.missing}{data:/b}")], [{}])),
        data: { b: "x".repeat(16_385) },
      }),
    ).toEqual({
      success: false,
      error: { path: "root.children[0].text", message: 'Unknown repeat field "missing"' },
    });
  });
});

describe("substituted text total", () => {
  const text = (value: string) => ({ type: "text", text: value });
  const totalError = (path: string) => ({
    success: false,
    error: { path, message: "Substituted text total limit exceeded" },
  });
  test.each([1, 2])("data-resolved text is charged per repeat item with %i fields", (count) => {
    const input = {
      ...spec(
        list(
          Array.from({ length: count }, () => text("{data:/b}")),
          Array.from({ length: 128 }, () => ({})),
          "i",
        ),
      ),
      data: { b: "x".repeat(16375) },
    };
    const result = validatePrototypeSpec(input);
    if (count === 1) {
      expect(result.success).toBe(true);
    } else {
      expect(result).toEqual(totalError("root.children[1].text"));
    }
  });
  test("literal text inside a repeat is not charged", () => {
    const input = spec(
      list(
        [text("x".repeat(16384)), text("x".repeat(16384))],
        Array.from({ length: 128 }, () => ({})),
        "i",
      ),
    );
    expect(validatePrototypeSpec(input).success).toBe(true);
  });
  test("data outside a repeat is charged once at the exact total", () => {
    const input = JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          "../../fixtures/prototype-spec/valid/substituted-text-total-exact.json",
        ),
        "utf8",
      ),
    );
    expect(validatePrototypeSpec(input).success).toBe(true);
  });
  test("condition operands reach exactly the total", () => {
    const operand = { key: "k", equals: "{item.b}y" };
    const child = {
      ...text("t"),
      visibleWhen: {
        all: Array.from({ length: 16 }, () => ({ any: Array.from({ length: 16 }, () => operand) })),
      },
    };
    const input = { ...spec(list([child], [{ b: "x".repeat(16375) }])), state: { k: "" } };
    expect(validatePrototypeSpec(input).success).toBe(true);
  });
  test("condition operands share the running total", () => {
    const operand = { key: "k", equals: "{item.b}y" };
    const child = {
      ...text("t"),
      visibleWhen: {
        all: Array.from({ length: 16 }, () => ({ any: Array.from({ length: 16 }, () => operand) })),
      },
    };
    const input = {
      ...spec(list([child, { ...text("t"), visibleWhen: operand }], [{ b: "x".repeat(16375) }])),
      state: { k: "" },
    };
    expect(validatePrototypeSpec(input)).toEqual(totalError("root.children[1].visibleWhen.equals"));
  });
  test.each([64, 65])("repeat total charges each item in order with %i fields", (count) => {
    const input = spec(
      list(
        Array.from({ length: count }, () => text("{i.b}")),
        Array.from({ length: 4 }, () => ({ b: "x".repeat(16379) })),
        "i",
      ),
    );
    // {i.b} is five units; each field/item charges exactly 16384.
    const result = validatePrototypeSpec(input);
    if (count === 64) {
      expect(result.success).toBe(true);
    } else {
      expect(result).toEqual(totalError("root.children[64].text"));
    }
  });
  test("per-field error wins on the first item before its total charge", () => {
    const input = spec(list([text("{item.b}{item.b}")], [{ b: "x".repeat(8193) }]));
    expect(validatePrototypeSpec(input)).toEqual({
      success: false,
      error: { path: "root.children[0].text", message: "Substituted text length limit exceeded" },
    });
  });
  test("unknown field wins before both substitution limits", () => {
    const input = {
      ...spec(list([text("{item.missing}{data:/b}")], [{}])),
      data: { b: "x".repeat(16385) },
    };
    expect(validatePrototypeSpec(input)).toEqual({
      success: false,
      error: { path: "root.children[0].text", message: 'Unknown repeat field "missing"' },
    });
  });
  test("unknown field wins before crossing the total", () => {
    const operand = { key: "k", equals: "{item.b}y" };
    const child = {
      ...text("t"),
      visibleWhen: {
        all: Array.from({ length: 16 }, () => ({ any: Array.from({ length: 16 }, () => operand) })),
      },
    };
    const input = {
      ...spec(list([child, text("{item.missing}{data:/s}")], [{ b: "x".repeat(16375) }])),
      state: { k: "" },
      data: { s: "" },
    };
    expect(validatePrototypeSpec(input)).toEqual({
      success: false,
      error: { path: "root.children[1].text", message: 'Unknown repeat field "missing"' },
    });
  });
});
