import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  FIXTURE_PROVENANCE_FILE,
  fixtureDirectoryProvenanceSchema,
  fixtureRootProvenanceSchema,
  parseProvenanceText,
  provenanceEntries,
} from "../../scripts/fixtures/fixtureProvenance";

const FIXTURES_DIR = path.resolve(import.meta.dir, "../fixtures");

const captured = {
  provenance: "captured",
  summary: "dumpsys display from an AAOS emulator",
  capturedOn: [{ device: "AAOS AVD", os: "Android API 34", formFactor: "automotive" }],
  date: "2026-11-09",
};

describe("fixture provenance schema (#18772)", () => {
  test("accepts each kind", () => {
    const entries = [
      captured,
      { provenance: "derived", summary: "s", derivedFrom: "#16750", edits: "trimmed" },
      { provenance: "generated", summary: "s", generator: "test/x.test.ts" },
      { provenance: "synthetic", summary: "s", reason: "pure logic" },
      { provenance: "handWritten", summary: "s", reason: "AOSP source", recapture: "#18774" },
    ];
    expect(
      entries.map((entry) => fixtureDirectoryProvenanceSchema.safeParse(entry).success),
    ).toEqual(entries.map(() => true));
  });

  test("a captured entry needs the device, OS, form factor and date", () => {
    expect(
      fixtureDirectoryProvenanceSchema.safeParse({ ...captured, capturedOn: [] }).success,
    ).toBe(false);
    const noOs = { ...captured, capturedOn: [{ device: "AAOS AVD", formFactor: "automotive" }] };
    expect(fixtureDirectoryProvenanceSchema.safeParse(noOs).success).toBe(false);
    expect(
      fixtureDirectoryProvenanceSchema.safeParse({ ...captured, date: "Nov 2026" }).success,
    ).toBe(false);
  });

  test("rejects unknown keys and a handWritten entry without a recapture issue", () => {
    expect(fixtureDirectoryProvenanceSchema.safeParse({ ...captured, extra: 1 }).success).toBe(
      false,
    );
    const handWritten = { provenance: "handWritten", summary: "s", reason: "AOSP source" };
    expect(fixtureDirectoryProvenanceSchema.safeParse(handWritten).success).toBe(false);
  });

  test("parts declare a mixed directory and are listed with the directory's own entry", () => {
    const parsed = fixtureDirectoryProvenanceSchema.parse({
      ...captured,
      parts: {
        "api30.txt": { provenance: "handWritten", summary: "s", reason: "AOSP", recapture: "#1" },
      },
    });
    expect(provenanceEntries(parsed).map((entry) => entry.provenance)).toEqual([
      "captured",
      "handWritten",
    ]);
    expect(
      fixtureDirectoryProvenanceSchema.safeParse({ ...captured, parts: { "../x": captured } })
        .success,
    ).toBe(false);
  });

  test("a provenance file may carry comments, and its name avoids *.json fixture listings", () => {
    expect(
      parseProvenanceText('{\n  // captured by hand\n  "provenance": "synthetic",\n}'),
    ).toEqual({
      provenance: "synthetic",
    });
    expect(FIXTURE_PROVENANCE_FILE.endsWith(".json")).toBe(false);
  });

  test("every provenance.jsonc under test/fixtures parses and its parts exist", () => {
    const failures = readdirSync(FIXTURES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(FIXTURES_DIR, entry.name))
      .filter((dir) => existsSync(path.join(dir, FIXTURE_PROVENANCE_FILE)))
      .flatMap((dir) => {
        const name = path.basename(dir);
        const raw = parseProvenanceText(
          readFileSync(path.join(dir, FIXTURE_PROVENANCE_FILE), "utf8"),
        );
        const result = fixtureDirectoryProvenanceSchema.safeParse(raw);
        if (!result.success) {
          return [`${name}: ${result.error.message}`];
        }
        return Object.keys(result.data.parts ?? {})
          .filter((part) => !existsSync(path.join(dir, part)))
          .map((part) => `${name}: part ${part} does not exist`);
      });
    expect(failures).toEqual([]);
  });

  test("the root provenance.jsonc declares only loose files that exist", () => {
    const rootFile = path.join(FIXTURES_DIR, FIXTURE_PROVENANCE_FILE);
    const root = fixtureRootProvenanceSchema.parse(
      parseProvenanceText(readFileSync(rootFile, "utf8")),
    );
    const missing = Object.keys(root.files).filter(
      (file) => !existsSync(path.join(FIXTURES_DIR, file)),
    );
    expect(missing).toEqual([]);
  });
});
