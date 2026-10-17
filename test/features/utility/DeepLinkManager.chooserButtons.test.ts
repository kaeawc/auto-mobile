import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { DeepLinkManager } from "../../../src/features/utility/DeepLinkManager";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

// A real ResolverActivity capture (android-36 emulator): Always / Just once buttons and app rows.
// See test/fixtures/intent-chooser/README.md for how it was captured.
const fixtureDir = path.join(import.meta.dir, "../../fixtures/intent-chooser");
const capture = JSON.parse(
  fs.readFileSync(path.join(fixtureDir, "observe-raw-artifact.json"), "utf8"),
);
const device = { deviceId: "emulator-5556", name: "emulator-5556", platform: "android" } as const;

const manager = new DeepLinkManager(device, new FakeAdbExecutor());
const parser = manager["parser"];
const rootNodes: unknown[] = parser.extractRootNodes(capture.viewHierarchy);

type Props = Record<string, unknown>;
const propsOf = (node: unknown): Props => parser.extractNodeProperties(node as never) as Props;

/** Every node of the capture in traversal order. */
function allNodes(): unknown[] {
  const nodes: unknown[] = [];
  for (const root of rootNodes) {
    parser.traverseNode(root as never, (node: unknown) => {
      nodes.push(node);
    });
  }
  return nodes;
}

/** The matcher as it was before moving onto the shared SearchableNode predicate. */
function legacyFindButtonByText(root: unknown, textOptions: string[]): unknown {
  let found: unknown = null;
  parser.traverseNode(root as never, (node: unknown) => {
    if (found) {
      return;
    }
    const properties = propsOf(node);
    const text = (properties.text || properties["content-desc"] || "") as string;
    const className = (properties.class || "") as string;
    if (
      (className.includes("Button") || className.includes("TextView")) &&
      textOptions.some((option) => text.toLowerCase().includes(option.toLowerCase()))
    ) {
      found = node;
    }
  });
  return found;
}

function find(root: unknown, textOptions: string[]): unknown {
  return manager["findButtonByText"](root, textOptions);
}

// Option sets are derived from the capture's own labels so the table covers what is on screen:
// each label, in upper case, and a prefix of it, plus the production sets and misses.
function optionTable(): string[][] {
  const labels = new Set<string>();
  for (const node of allNodes()) {
    const properties = propsOf(node);
    for (const value of [properties.text, properties["content-desc"]]) {
      if (typeof value === "string" && value.trim() !== "") {
        labels.add(value);
      }
    }
  }
  const derived = [...labels].flatMap((label) => [[label.toUpperCase()], [label.slice(0, 3)]]);
  return [
    ["Always", "ALWAYS"],
    ["Just once", "JUST ONCE", "Once"],
    ["nomatch-xyz"],
    ["Always", "nomatch-xyz"],
    ...derived,
  ];
}

describe("DeepLinkManager.findButtonByText over a captured ResolverActivity", () => {
  test("the capture has the chooser buttons and app rows", () => {
    const resourceIds = allNodes().map((node) => propsOf(node)["resource-id"]);
    expect(resourceIds).toContain("android:id/button_always");
    expect(resourceIds).toContain("android:id/button_once");
    expect(resourceIds).toContain("android:id/resolver_list");
  });

  test.each([
    ["always", ["Always", "ALWAYS"], "android:id/button_always", "Always"],
    ["just once", ["Just once", "JUST ONCE", "Once"], "android:id/button_once", "Just once"],
    ["case-insensitive", ["ONCE"], "android:id/button_once", "Just once"],
  ])("finds the %s button", (_name, options, resourceId, text) => {
    const found = rootNodes.map((root) => find(root, options)).find(Boolean);
    expect(found).toBeDefined();
    expect(propsOf(found)).toMatchObject({ "resource-id": resourceId, text });
  });

  test("finds nothing for a label that is not on screen", () => {
    expect(rootNodes.map((root) => find(root, ["nomatch-xyz"])).find(Boolean)).toBeUndefined();
  });

  test("matches the previous matcher for every option set on every root and subtree", () => {
    const table = optionTable();
    expect(table.length).toBeGreaterThan(20);
    // Roots plus the subtree of every labelled or button-like node.
    const starts = [
      ...rootNodes,
      ...allNodes().filter((node) => {
        const properties = propsOf(node);
        return (
          String(properties.class ?? "").includes("Button") ||
          typeof properties.text === "string" ||
          typeof properties["content-desc"] === "string"
        );
      }),
    ];
    const mismatches = table.flatMap((options) =>
      starts.filter((start) => find(start, options) !== legacyFindButtonByText(start, options)),
    );
    expect(mismatches).toEqual([]);
  });

  test("matches the previous matcher on edited copies of the captured buttons", () => {
    // Variants of the real Always / Just once nodes that reach the less common branches.
    const original = allNodes().find(
      (node) => propsOf(node)["resource-id"] === "android:id/button_always",
    ) as Record<string, unknown>;
    const variants: Record<string, unknown>[] = [
      { ...original, text: "  ", "content-desc": "Always" },
      { ...original, text: "", "content-desc": "Always" },
      { ...original, text: undefined, "content-desc": "Always" },
      { ...original, class: undefined, className: "android.widget.Button" },
      { ...original, class: undefined, className: undefined },
      { ...original, class: "android.widget.TextView", text: "Just once" },
      { ...original, class: "androidx.appcompat.widget.AppCompatButton", text: "ALWAYS ask" },
      { ...original, class: "android.view.View" },
      { ...original, text: " Always ", "content-desc": "Just once" },
    ];
    for (const variant of variants) {
      for (const options of [["Always", "ALWAYS"], ["Just once", "Once"], ["nomatch-xyz"], [""]]) {
        expect(find(variant, options) === variant).toBe(
          legacyFindButtonByText(variant, options) === variant,
        );
      }
    }
  });

  test("still honours a per-instance override of the findButtonByText seam", () => {
    const patched = new DeepLinkManager(device, new FakeAdbExecutor());
    const node = allNodes().find(
      (candidate) => propsOf(candidate)["resource-id"] === "android:id/button_always",
    );
    Object.defineProperty(patched, "findButtonByText", { value: () => node });
    const element = patched["findChooserButton"](rootNodes as never, ["Never"]);
    expect(element?.["resource-id"]).toBe("android:id/button_always");
    expect(element?.bounds).toEqual(parser.parseNodeBounds(node as never)?.bounds);
  });

  test.each([
    ["always", "android:id/button_always"],
    ["just_once", "android:id/button_once"],
  ] as const)("taps the centre of the %s button, not NaN", async (preference, resourceId) => {
    const adb = new FakeAdbExecutor();
    const tapper = new DeepLinkManager(device, adb);
    const result = await tapper.handleIntentChooser(capture.viewHierarchy, preference);
    expect(result).toMatchObject({ success: true, detected: true, action: preference });
    const node = allNodes().find((candidate) => propsOf(candidate)["resource-id"] === resourceId);
    const bounds = parser.parseNodeBounds(node as never)?.bounds;
    expect(bounds).toBeDefined();
    const center = tapper["geometry"].getElementCenter({ bounds } as never);
    expect(adb.getExecutedCommands()).toContain(`shell input tap ${center.x} ${center.y}`);
  });
});
