import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderPrototypeGuide } from "../../../src/features/prototype/prototypeGuide";
import { prototypeAccessibilityOutput } from "../../../src/features/prototype/prototypeAccessibilityLint";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { untaggedInteractiveNodes } from "../../helpers/prototypeTestTags";

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

type Json = Record<string, unknown>;

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
        expect(untaggedInteractiveNodes(decoded.get(name))).toEqual([]);
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
