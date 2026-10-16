import { beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { analyseChooserCapture, CHOOSER_EXPECTED_PATH } from "../../helpers/chooserAnalysis";

// Pins the chooser analysis (detection, list, anchor rows and signatures, per-package row
// lookup, collected labels) on a real ResolverActivity capture. The expected file was produced
// by the same analysis before the chooser reads moved onto SearchableNode.
const expected = JSON.parse(fs.readFileSync(CHOOSER_EXPECTED_PATH, "utf8"));
let actual: Awaited<ReturnType<typeof analyseChooserCapture>>;

beforeAll(async () => {
  actual = await analyseChooserCapture();
});

describe("DeepLinkManager chooser analysis over a captured ResolverActivity", () => {
  test("detects the chooser, and stops once its indicators are gone", () => {
    expect(actual.detectAll).toBe(expected.detectAll);
    expect(actual.detectWithout).toEqual(expected.detectWithout);
    expect(actual.detectStripped).toBe(expected.detectStripped);
  });

  test("detects from a single surviving indicator of each kind", () => {
    expect(actual.detectSingleIndicator).toEqual(expected.detectSingleIndicator);
    expect(actual.detectSingleIndicator.contentDescOnly).toBe(true);
    // Blank text blocks the content-description fallback, as it always has.
    expect(actual.detectSingleIndicator.blankTextWithDescription).toBe(false);
  });

  test("finds the list and anchor rows with their page signatures", () => {
    expect(actual.original.list).toEqual(expected.original.list);
    expect(actual.original.anchors).toEqual(expected.original.anchors);
    expect(actual.namespaced.anchors).toEqual(expected.namespaced.anchors);
    expect(actual.mixed.list).toEqual(expected.mixed.list);
    expect(actual.mixed.anchors).toEqual(expected.mixed.anchors);
    expect(actual.mixed.anchors.length).toBeGreaterThan(1);
  });

  test("collects the row labels per package lookup", () => {
    expect(actual.original.labels).toEqual(expected.original.labels);
    expect(actual.namespaced.labels).toEqual(expected.namespaced.labels);
    expect(actual.mixed.labels).toEqual(expected.mixed.labels);
  });

  test("resolves app rows by resource-id namespace and refuses unknown packages", () => {
    expect(actual.original.apps).toEqual(expected.original.apps);
    expect(actual.namespaced.apps).toEqual(expected.namespaced.apps);
    expect(actual.mixed.apps).toEqual(expected.mixed.apps);
    const resolved = Object.entries(actual.namespaced.apps).filter(
      ([, result]) => (result as { ok: boolean }).ok,
    );
    expect(resolved.map(([pkg]) => pkg)).toEqual([
      "com.pkg0",
      "com.pkg1",
      "com.pkg2",
      "com.pkg3",
      "com.pkg4",
    ]);
  });
});
