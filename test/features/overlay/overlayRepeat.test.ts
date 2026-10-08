import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repeatErrors, repeatFieldReferences } from "../../../src/features/overlay/overlayRepeat";
import { validateOverlaySpec } from "../../../src/features/overlay/overlayValidation";

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
    // 1 container + 10 * 49 = 491 nodes fits; 10 * 50 = 500 + 1 does not.
    expect(repeatErrors(spec(list(spacers(49), items)))).toBeUndefined();
    expect(repeatErrors(spec(list(spacers(50), items)))).toEqual({
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
        join(import.meta.dir, "../../fixtures/overlay-spec/valid/repeat-component-labels.json"),
        "utf8",
      ),
    );
    expect(validateOverlaySpec(fixture).success).toBe(true);
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
    expect(validateOverlaySpec(spec(node)).success).toBe(true);
    expect(validateOverlaySpec(spec({ type: "box", children: [node] })).success).toBe(false);
  });
});

test("the public schema constrains repeat items to flat scalar maps", () => {
  const repeatItems = (value: unknown) =>
    validateOverlaySpec(
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
    join(import.meta.dir, "../../../docs/design-docs/plat/android/overlay-ux.md"),
    "utf8",
  ).replace(/\r\n/g, "\n"); // Windows checkouts may convert the doc to CRLF
  const section = document.split("### List templates: repeat")[1];
  const snippet = section.split("```json\n")[1].split("```")[0];
  const result = validateOverlaySpec({ ...spec(JSON.parse(snippet)), state: { picked: "a" } });
  expect(result.success).toBe(true);
});
