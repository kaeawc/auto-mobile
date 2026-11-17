import { beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { bundleForBrowser, type BrowserBundle } from "./browserBundle";

/** One 0.5 MB budget for an export's HTML, JS and CSS together (prototype-web-library.md). */
const MAX_EXPORT_BYTES = 500_000;

/**
 * Where the library's import closure may reach (#16453): the renderer, the CtrlProxy capability
 * constants it names, and the root manifest for its version. No dependency, server module,
 * logger or config.
 */
const ALLOWED_INPUT_PREFIXES = [
  "packages/prototype-web/src/",
  "src/features/prototype/",
  "src/features/observe/android/ctrlProxyProtocol/",
];
const ALLOWED_INPUTS = new Set([
  "package.json",
  "src/features/observe/android/ctrlProxyProtocol.ts",
]);

const entry = fileURLToPath(
  new URL("../../../../packages/prototype-web/src/index.ts", import.meta.url),
);

describe("prototype-web library bundle (#16453)", () => {
  let bundle: BrowserBundle;
  beforeAll(async () => {
    bundle = await bundleForBrowser(entry);
  });

  test("reaches no Node builtin", () => {
    expect(bundle.builtins).toEqual([]);
  });

  test("reaches only the renderer: no dependency or server module", () => {
    expect(bundle.inputs.length).toBeGreaterThan(0);
    const outside = bundle.inputs.filter(
      (input) =>
        !ALLOWED_INPUTS.has(input) &&
        !ALLOWED_INPUT_PREFIXES.some((prefix) => input.startsWith(prefix)),
    );
    expect(outside).toEqual([]);
  });

  test("bundles only the version from the root manifest", () => {
    expect(bundle.code).not.toContain('"@kaeawc/auto-mobile"');
    expect(bundle.code).not.toContain("modelcontextprotocol");
  });

  test("stays within the combined HTML, JS and CSS budget", () => {
    expect(bundle.totalBytes).toBeGreaterThan(0);
    expect(bundle.totalBytes).toBeLessThanOrEqual(MAX_EXPORT_BYTES);
  });
});
