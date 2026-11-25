/**
 * Directory-level provenance for test/fixtures (#18772, #18771).
 *
 * Every top-level directory under test/fixtures holds a `provenance.jsonc` that says where its
 * files came from; loose files directly under test/fixtures are declared in the `files` map of
 * `test/fixtures/provenance.jsonc`. It is JSON (comments allowed) under a `.jsonc` name because
 * many fixture tests in TypeScript, Kotlin and Swift list a directory's `*.json` files as its
 * cases. The capture harness's per-file `<name>.provenance.json` sidecars
 * (`scripts/fixtures/promote-capture.ts`) are a separate, stricter record of one promoted capture.
 *
 * Kinds:
 * - `captured`: real output from a device, simulator, emulator or host tool run.
 * - `derived`: a captured source edited (redacted, truncated, renamed, one value changed).
 * - `generated`: written by a generator or test from code, such as wire-contract goldens.
 * - `synthetic`: authored input for pure logic, CI or host contracts that no device prints.
 * - `handWritten`: device output reconstructed by hand instead of captured. Only the
 *   shrink-only legacy list may hold these; each names the issue that recaptures it.
 *
 * A directory whose files differ in kind declares the main kind at the top and the others in
 * `parts`, keyed by a path relative to the directory (a file or a subdirectory).
 */
import { z } from "zod";

export const FIXTURE_PROVENANCE_FILE = "provenance.jsonc";

/** Parses a provenance file's text: JSON that may carry comments and trailing commas. */
export function parseProvenanceText(text: string): unknown {
  return Bun.JSONC.parse(text);
}

export const FIXTURE_PROVENANCE_KINDS = [
  "captured",
  "derived",
  "generated",
  "synthetic",
  "handWritten",
] as const;
export type FixtureProvenanceKind = (typeof FIXTURE_PROVENANCE_KINDS)[number];

const text = z.string().trim().min(1);

/** One device, simulator, emulator or host the files were captured on. */
const capturedOnSchema = z.strictObject({
  /** For example "Pixel 7 AVD (emulator-5600)", "iPhone 17 simulator", "macOS host". */
  device: text,
  /** For example "Android API 36", "iOS 26.5", "Wear OS 7.0 (API 37)", "macOS 26". */
  os: text,
  /** A device form factor, or `host` for a host tool run. */
  formFactor: z.enum([
    "phone",
    "tablet",
    "foldable",
    "tv",
    "watch",
    "automotive",
    "xr-headset",
    "xr-glasses",
    "host",
  ]),
});

const common = {
  /** What the files are, in one line. */
  summary: text,
  /** Where the evidence is: an issue, PR, README or capture run. */
  source: text.optional(),
};

const capturedSchema = z.strictObject({
  provenance: z.literal("captured"),
  ...common,
  capturedOn: z.array(capturedOnSchema).min(1),
  /** YYYY-MM-DD of the capture, or of the commit that added it when the capture date is unknown. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const derivedSchema = z.strictObject({
  provenance: z.literal("derived"),
  ...common,
  /** The captured source: a fixture path, issue or run. */
  derivedFrom: text,
  /** What was changed, for example "redacted serials" or "truncated to the focused window". */
  edits: text,
});

const generatedSchema = z.strictObject({
  provenance: z.literal("generated"),
  ...common,
  /** The generator script or test that writes or pins the files. */
  generator: text,
});

const syntheticSchema = z.strictObject({
  provenance: z.literal("synthetic"),
  ...common,
  /** Why no capture is needed, for example "pure layout logic" or "CI log parser input". */
  reason: text,
});

const handWrittenSchema = z.strictObject({
  provenance: z.literal("handWritten"),
  ...common,
  /** What the files were reconstructed from. */
  reason: text,
  /** The issue that recaptures them, as `#NNNN`. */
  recapture: z.string().regex(/^#\d+$/),
});

export const fixtureProvenanceEntrySchema = z.discriminatedUnion("provenance", [
  capturedSchema,
  derivedSchema,
  generatedSchema,
  syntheticSchema,
  handWrittenSchema,
]);
export type FixtureProvenanceEntry = z.infer<typeof fixtureProvenanceEntrySchema>;

const relativePath = z
  .string()
  .min(1)
  .refine((key) => !key.startsWith("/") && !key.split("/").includes(".."), {
    message: "must be a path relative to the fixture directory",
  });

const parts = { parts: z.record(relativePath, fixtureProvenanceEntrySchema).optional() };

/** A directory's `provenance.json`: one entry, plus per-path entries for mixed directories. */
export const fixtureDirectoryProvenanceSchema = z.discriminatedUnion("provenance", [
  capturedSchema.extend(parts),
  derivedSchema.extend(parts),
  generatedSchema.extend(parts),
  syntheticSchema.extend(parts),
  handWrittenSchema.extend(parts),
]);
export type FixtureDirectoryProvenance = z.infer<typeof fixtureDirectoryProvenanceSchema>;

/** `test/fixtures/provenance.json`: one entry per loose file directly under test/fixtures. */
export const fixtureRootProvenanceSchema = z.strictObject({
  files: z.record(relativePath, fixtureProvenanceEntrySchema),
});
export type FixtureRootProvenance = z.infer<typeof fixtureRootProvenanceSchema>;

/** Every entry a directory declares, its own first, so a caller can find `handWritten` parts. */
export function provenanceEntries(
  provenance: FixtureDirectoryProvenance,
): FixtureProvenanceEntry[] {
  const { parts: declaredParts, ...own } = provenance;
  return [own, ...Object.values(declaredParts ?? {})];
}
