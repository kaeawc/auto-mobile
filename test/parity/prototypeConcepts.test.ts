import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOTYPE_ICON_SF_SYMBOLS_CAPABILITY } from "../../src/features/observe/android/ctrlProxyProtocol";
import { lintPrototypeAccessibility } from "../../src/features/prototype/prototypeAccessibilityLint";
import {
  prototypeRolePalette,
  resolvePrototypeColor,
} from "../../src/features/prototype/prototypeContrast";
import { prototypePlatformNotes } from "../../src/features/prototype/prototypePlatformNotes";
import { record } from "../../src/features/prototype/prototypeTemplate";
import {
  prototypeGateCapabilities,
  requiredPrototypeCapabilities,
} from "../../src/features/prototype/prototypeCapabilityGates";
import { validatePrototypeSpec } from "../../src/features/prototype/prototypeValidation";
import { untaggedInteractiveNodes } from "../helpers/prototypeTestTags";

/** Reference concept slices (#14205); the Kotlin and Swift suites load the same directories. */
const conceptsDirectory = join(import.meta.dir, "../fixtures/prototype-concepts");
const CONCEPT_FILES = ["README.md", "concept.json", "today.json"];

interface ConceptManifest {
  issue: number;
  name: string;
  capabilities: string[];
}
interface Concept {
  name: string;
  files: string[];
  manifest: ConceptManifest;
  readme: string;
  json: string;
  spec?: Record<string, unknown>;
  /** Derived in beforeAll so each test stays inside the unit timing budget. */
  gateCapabilities?: string[];
  requiredCapabilities?: string[];
  untagged?: string[];
  lintFindings?: unknown[];
  unmappedIcons?: unknown[];
}

const concepts: Concept[] = readdirSync(conceptsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .map((name) => {
    const directory = join(conceptsDirectory, name);
    return {
      name,
      files: readdirSync(directory).sort(),
      manifest: JSON.parse(
        readFileSync(join(directory, "concept.json"), "utf8"),
      ) as ConceptManifest,
      readme: readFileSync(join(directory, "README.md"), "utf8"),
      json: readFileSync(join(directory, "today.json"), "utf8"),
    };
  });

describe("prototype concept slices", () => {
  beforeAll(() => {
    for (const concept of concepts) {
      const result = validatePrototypeSpec(concept.json);
      if (!result.success) {
        throw new Error(`${concept.name}: ${JSON.stringify(result.error)}`);
      }
      concept.spec = JSON.parse(concept.json) as Record<string, unknown>;
      concept.gateCapabilities = prototypeGateCapabilities(concept.spec);
      concept.requiredCapabilities = requiredPrototypeCapabilities(concept.spec);
      concept.untagged = untaggedInteractiveNodes(concept.spec);
      concept.lintFindings = lintPrototypeAccessibility(concept.spec).findings;
      // The SF Symbols path checks every contract iconName slot against the schema's mapped table.
      concept.unmappedIcons = prototypePlatformNotes(
        result.data,
        "ios",
        (capability) => capability === PROTOTYPE_ICON_SF_SYMBOLS_CAPABILITY,
      ).filter((note) => note.construct === "icon.name");
    }
  });

  test("the corpus holds at least one concept", () => {
    expect(concepts.length).toBeGreaterThan(0);
  });

  for (const concept of concepts) {
    describe(concept.name, () => {
      test("holds exactly the slice, its manifest and its README", () => {
        expect(concept.files).toEqual(CONCEPT_FILES);
        expect(concept.manifest.issue).toBeGreaterThan(0);
        expect(concept.manifest.name.length).toBeGreaterThan(0);
      });

      test("is a multi-screen stack whose id names the concept", () => {
        expect(concept.spec?.id).toBe(`${concept.name}-today`);
        const root = concept.spec?.root as Record<string, unknown>;
        expect(root.type).toBe("stack");
        expect(Object.keys(root.screens as Record<string, unknown>).length).toBeGreaterThan(1);
      });

      test("records the gate capabilities every strict policy derives", () => {
        expect(concept.gateCapabilities).toEqual(concept.manifest.capabilities);
      });

      test("paints an opaque background behind every top-level screen", () => {
        const root = record(concept.spec?.root);
        // Direct root.screens entries share the stack's background; nested content need not paint.
        for (const mode of ["light", "dark"] as const) {
          const palette = prototypeRolePalette(concept.spec, mode);
          const isOpaque = (node: unknown): boolean => {
            const style = record(record(node)?.style);
            return (
              (style?.alpha ?? 1) === 1 &&
              resolvePrototypeColor(style?.background, mode, palette)?.a === 1
            );
          };
          const uncovered = Object.entries(record(root?.screens) ?? {})
            .filter(([, screen]) => !isOpaque(root) && !isOpaque(screen))
            .map(([name]) => `${mode}:${name}`);
          expect(uncovered).toEqual([]);
        }
      });

      test("uses only icon names in the iOS symbol schema's mapped table", () => {
        expect(concept.unmappedIcons).toEqual([]);
      });

      test("lists every required capability in its README", () => {
        const missing = (concept.requiredCapabilities ?? []).filter(
          (capability) => !concept.readme.includes(`\`${capability}\``),
        );
        expect(missing).toEqual([]);
      });

      test("sets a testTag on every interactive node", () => {
        expect(concept.untagged).toEqual([]);
      });

      test("has no static accessibility lint findings", () => {
        expect(concept.lintFindings).toEqual([]);
      });
    });
  }
});
