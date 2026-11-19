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

const entryPath = (name: string) =>
  fileURLToPath(new URL(`../../../../packages/prototype-web/src/${name}.ts`, import.meta.url));

/** The `<automobile-prototype>` element is a thin layer: it adds at most this much over `mount`. */
const MAX_ELEMENT_OVERHEAD_BYTES = 8_000;

describe.each(["index", "element"])("prototype-web %s bundle (#16453, #16454)", (name) => {
  let bundle: BrowserBundle;
  beforeAll(async () => {
    bundle = await bundleForBrowser(entryPath(name));
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

describe("prototype-web element bundle (#16454)", () => {
  let library: BrowserBundle;
  let element: BrowserBundle;
  beforeAll(async () => {
    [library, element] = await Promise.all([
      bundleForBrowser(entryPath("index")),
      bundleForBrowser(entryPath("element")),
    ]);
  });

  test("adds little over the library it wraps", () => {
    expect(element.totalBytes - library.totalBytes).toBeLessThanOrEqual(MAX_ELEMENT_OVERHEAD_BYTES);
  });

  test("registers the element only when custom elements exist", () => {
    expect(element.code).toContain("automobile-prototype");
    expect(element.code).toContain("customElements");
  });
});
