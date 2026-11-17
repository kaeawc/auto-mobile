import { beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { bundleForBrowser, type BrowserBundle } from "./browserBundle";

/** Budget from docs/how-it-works/prototype-web-library.md for the core entry. */
// Owner set one 0.5 MB budget for the export's HTML, JS and CSS counted together, minified, in
// place of the separate minified and gzip limits that were raised per merge.
const MAX_EXPORT_BYTES = 500_000;

/** Server-only modules the renderer once reached; any of them back in the closure is a regression. */
const FORBIDDEN_INPUTS = [
  "schemas/prototype-spec-contract.json",
  "node_modules/zod/",
  "src/utils/logger.ts",
  "src/config/",
  "src/models/ActionableError.ts",
  "src/models/describeUnknownError.ts",
];

const entry = fileURLToPath(
  new URL("../../../fixtures/prototype-web-bundle/stillEntry.ts", import.meta.url),
);
describe("still renderer browser bundle (#16451)", () => {
  let bundle: BrowserBundle;
  beforeAll(async () => {
    bundle = await bundleForBrowser(entry);
  });

  test("reaches no Node builtin", () => {
    expect(bundle.builtins).toEqual([]);
  });

  test("leaves the contract JSON, zod and the server logger out", () => {
    expect(bundle.inputs.length).toBeGreaterThan(0);
    expect(
      bundle.inputs.filter((input) => FORBIDDEN_INPUTS.some((part) => input.includes(part))),
    ).toEqual([]);
  });

  test("tree-shakes the server-only Android wire tables (#16804)", () => {
    const wireTypes = ["request_hierarchy_if_stale", "hierarchy_update"];
    expect(wireTypes.filter((type) => bundle.code.includes(`"${type}"`))).toEqual([]);
  });

  test("stays within the combined HTML, JS and CSS budget", () => {
    expect(bundle.totalBytes).toBeGreaterThan(0);
    expect(bundle.totalBytes).toBeLessThanOrEqual(MAX_EXPORT_BYTES);
  });
});
