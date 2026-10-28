import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderPrototypeGuide } from "../../../src/features/prototype/prototypeGuide";
import { PROTOTYPE_NODE_TYPES } from "../../../src/features/prototype/prototypeSpec";
import { prototypeAccessibilityOutput } from "../../../src/features/prototype/prototypeAccessibilityLint";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const root = join(import.meta.dir, "../../..");
const validDirectory = join(root, "test/fixtures/prototype-spec/valid");

/** The gallery documented in docs/using/hackathon.md and the authoring guide. */
const TEMPLATES = [
  "template-onboarding.json",
  "template-feed-detail.json",
  "template-tabbed-home.json",
  "template-checkout.json",
  "template-settings.json",
  "template-search.json",
  "template-chat.json",
  "template-dashboard.json",
];

/** Node types a user taps, types into or drags; each needs a testTag so scripts can find it. */
const INTERACTIVE_TYPES = new Set([
  "button",
  "iconButton",
  "fab",
  "chip",
  "textField",
  "switch",
  "checkbox",
  "radioGroup",
  "select",
  "slider",
  "segmentedButton",
  "tabBar",
  "bottomNav",
  "searchBar",
  "datePicker",
  "timePicker",
  "listItem",
]);
const GESTURE_KEYS = ["onTap", "onLongPress", "onDoubleTap"];
const NODE_TYPES = new Set<string>(PROTOTYPE_NODE_TYPES);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Every node object under `value`; a list item's `trailing` control is part of its row. */
function nodes(value: unknown, found: Json[] = []): Json[] {
  if (Array.isArray(value)) {
    for (const child of value) {
      nodes(child, found);
    }
    return found;
  }
  if (!isObject(value)) {
    return found;
  }
  if (typeof value.type === "string" && NODE_TYPES.has(value.type)) {
    found.push(value);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== "trailing") {
      nodes(child, found);
    }
  }
  return found;
}

const read = (path: string): string => readFileSync(join(root, path), "utf8");
const decoded = new Map<string, Json>();
let guide = "";

describe("prototype template gallery", () => {
  beforeAll(() => {
    guide = renderPrototypeGuide();
    for (const name of TEMPLATES) {
      const text = readFileSync(join(validDirectory, name), "utf8");
      const result = validatePrototypeSpec(text);
      if (!result.success) {
        throw new Error(`${name}: ${JSON.stringify(result.error)}`);
      }
      decoded.set(name, JSON.parse(text) as Json);
    }
  });

  test("the corpus holds exactly the documented templates", () => {
    const onDisk = readdirSync(validDirectory)
      .filter((name) => name.startsWith("template-"))
      .sort();
    expect(onDisk).toEqual([...TEMPLATES].sort());
  });

  for (const name of TEMPLATES) {
    describe(name, () => {
      test("is a multi-screen stack whose id matches the file", () => {
        const spec = decoded.get(name);
        expect(spec?.id).toBe(name.replace(/\.json$/, ""));
        const stack = spec?.root as Json;
        expect(stack.type).toBe("stack");
        expect(Object.keys(stack.screens as Json).length).toBeGreaterThanOrEqual(2);
      });

      test("sets a testTag on every interactive node", () => {
        const untagged = nodes(decoded.get(name)).filter(
          (node) =>
            (INTERACTIVE_TYPES.has(node.type as string) ||
              GESTURE_KEYS.some((key) => node[key] !== undefined)) &&
            typeof node.testTag !== "string",
        );
        expect(untagged.map((node) => JSON.stringify(node).slice(0, 80))).toEqual([]);
      });

      test("passes the accessibility lint with zero findings (#14126)", () => {
        expect(prototypeAccessibilityOutput(decoded.get(name))).toEqual({});
      });

      test("is listed in the authoring guide and the hackathon guide", () => {
        expect(guide).toContain(`\`${name}\``);
        expect(read("docs/using/hackathon.md")).toContain(`\`${name}\``);
      });
    });
  }

  test("the hackathon guide is linked from the docs index and nav", () => {
    expect(read("mkdocs.yml")).toContain("using/hackathon.md");
    expect(read("docs/index.md")).toContain("using/hackathon.md");
  });
});
