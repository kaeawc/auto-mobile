import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  expandPrototypeComponents,
  MAX_PROTOTYPE_COMPONENT_DEPTH,
  prototypeSpecForDevice,
} from "../../../src/features/prototype/prototypeComponents";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const fixtures = join(import.meta.dir, "../../fixtures/prototype-spec");
const read = (path: string): unknown => JSON.parse(readFileSync(join(fixtures, path), "utf8"));
const names = (directory: string) =>
  readdirSync(join(fixtures, directory))
    .filter((name) => name.endsWith(".json"))
    .sort();

const spec = (root: unknown, components?: unknown, state?: unknown) => ({
  id: "c",
  window: { placement: { type: "fullscreen" } },
  ...(state === undefined ? {} : { state }),
  ...(components === undefined ? {} : { components }),
  root,
});

describe("component expansion fixtures", () => {
  test("the gallery expands to exactly the same spec written out by hand", () => {
    const expansion = expandPrototypeComponents(read("components/gallery.json"));
    expect(expansion.success).toBe(true);
    expect(expansion.success && expansion.spec).toEqual(read("valid/component-gallery.json"));
    expect(validatePrototypeSpec(read("components/gallery.json")).success).toBe(true);
  });

  for (const name of names("components/expand")) {
    test(`expands ${name}`, () => {
      const fixture = read(`components/expand/${name}`) as { spec: unknown; expanded: unknown };
      const expansion = expandPrototypeComponents(fixture.spec);
      expect(expansion.success && expansion.spec).toEqual(fixture.expanded);
      expect(validatePrototypeSpec(fixture.spec).success).toBe(true);
    });
  }

  for (const name of names("components/invalid")) {
    const fixture = read(`components/invalid/${name}`) as {
      spec: unknown;
      expectedPath: string;
      expectedMessage: string;
    };
    test(`rejects ${name} at ${fixture.expectedPath}`, () => {
      expect(validatePrototypeSpec(fixture.spec)).toEqual({
        success: false,
        error: { path: fixture.expectedPath, message: fixture.expectedMessage },
      });
    });
  }
});

describe("expandPrototypeComponents", () => {
  test("a spec without components or use nodes is returned as the same object", () => {
    const plain = spec({ type: "text", text: "{props.x}" });
    const expansion = expandPrototypeComponents(plain);
    expect(expansion).toMatchObject({ success: true, expanded: false });
    expect(expansion.success && expansion.spec).toBe(plain);
    expect(prototypeSpecForDevice(plain)).toBe(plain);
    expect(prototypeSpecForDevice("not a spec")).toBe("not a spec");
  });

  test("a use node without a components map names the unknown component", () => {
    expect(expandPrototypeComponents(spec({ type: "use", component: "row" }))).toEqual({
      success: false,
      error: { path: "root.component", message: 'Unknown component "row"' },
    });
  });

  test("a use inside a repeat template binds props from the repeat item", () => {
    const authored = spec(
      {
        type: "column",
        repeat: { items: [{ id: "a" }, { id: "b" }], as: "item" },
        children: [{ type: "use", component: "like", props: { key: "liked_{item.id}" } }],
      },
      {
        like: {
          root: { type: "text", text: "Like", onTap: [{ type: "toggle", key: "{props.key}" }] },
        },
      },
      { liked_a: false, liked_b: true },
    );
    const device = prototypeSpecForDevice(authored) as { root: { children: unknown[] } };
    expect(device.root.children).toEqual([
      { type: "text", text: "Like", onTap: [{ type: "toggle", key: "liked_{item.id}" }] },
    ]);
    expect(validatePrototypeSpec(authored).success).toBe(true);
  });

  test("nesting is bounded at the documented depth", () => {
    const chain = (depth: number) =>
      Object.fromEntries(
        Array.from({ length: depth }, (_, index) => [
          `c${index}`,
          {
            root:
              index + 1 < depth ? { type: "use", component: `c${index + 1}` } : { type: "spacer" },
          },
        ]),
      );
    const root = { type: "use", component: "c0" };
    expect(
      expandPrototypeComponents(spec(root, chain(MAX_PROTOTYPE_COMPONENT_DEPTH))).success,
    ).toBe(true);
    const deeper = expandPrototypeComponents(spec(root, chain(MAX_PROTOTYPE_COMPONENT_DEPTH + 1)));
    expect(deeper.success ? undefined : deeper.error.message).toBe(
      "Component nesting depth limit exceeded",
    );
  });

  test("a component used many times stops at the node limit instead of growing", () => {
    // 50 uses of a 50-node block is 2500 nodes if expanded naively, past the 2000-node limit.
    // Few `use` expansions with wide roots keep this inside the unit-test budget: locating the
    // authored path of every `use` scans all earlier ones, so many tiny uses are quadratic.
    const components = {
      block: {
        root: { type: "row", children: Array.from({ length: 49 }, () => ({ type: "spacer" })) },
      },
    };
    const root = {
      type: "column",
      children: Array.from({ length: 50 }, () => ({ type: "use", component: "block" })),
    };
    const expansion = expandPrototypeComponents(spec(root, components));
    expect(expansion.success ? undefined : expansion.error.message).toBe(
      "Expanded node limit exceeded",
    );
  });

  test("the components map must be an object of named roots", () => {
    expect(expandPrototypeComponents(spec({ type: "spacer" }, []))).toEqual({
      success: false,
      error: { path: "components", message: "Expected object" },
    });
    expect(expandPrototypeComponents(spec({ type: "spacer" }, { a: { root: "x" } }))).toEqual({
      success: false,
      error: { path: "components.a.root", message: "Expected object" },
    });
  });

  test("an error outside every component keeps its authored path", () => {
    const authored = spec(
      {
        type: "column",
        children: [
          { type: "use", component: "a" },
          { type: "button", label: "" },
        ],
      },
      { a: { root: { type: "spacer" } } },
    );
    expect(validatePrototypeSpec(authored)).toEqual({
      success: false,
      error: { path: "root.children[1].label", message: "Invalid string value" },
    });
  });
});
