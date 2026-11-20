import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { version } from "../../../../package.json";
import {
  assertPrototypeWebExportBudget,
  buildPrototypeWebPageBundleModule,
  MAX_PROTOTYPE_WEB_EXPORT_BYTES,
  PROTOTYPE_WEB_PAGE_VERSION_MARK,
  prototypeWebPageBundlePath,
} from "../../../../packages/prototype-web/build";
import { prototypeWebPageBundle } from "../../../../src/features/prototype/web/prototypeWebPageBundle";
import {
  PROTOTYPE_WEB_PAGE_BUNDLE_SOURCE,
  PROTOTYPE_WEB_PAGE_BUNDLE_VERSION_MARK,
} from "../../../../src/features/prototype/web/prototypeWebPageBundle.generated";

const committedModule = () =>
  readFileSync(
    fileURLToPath(new URL(`../../../../${prototypeWebPageBundlePath}`, import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");

describe("committed prototype web page bundle (#16528)", () => {
  let fresh: string;
  beforeAll(async () => {
    fresh = await buildPrototypeWebPageBundleModule();
  });

  test("matches a fresh packages/prototype-web/build.ts build", () => {
    // Stale: regenerate with `cd packages/prototype-web && bun run build` and commit the file.
    expect(committedModule() === fresh).toBe(true);
  });

  test("stays within the export budget", () => {
    const bytes = Buffer.byteLength(PROTOTYPE_WEB_PAGE_BUNDLE_SOURCE);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(MAX_PROTOTYPE_WEB_EXPORT_BYTES);
  });

  test("can be inlined in a script element", () => {
    expect(PROTOTYPE_WEB_PAGE_BUNDLE_SOURCE).not.toMatch(/<\/script|<!--/i);
  });

  test("names its version only through the mark, which the server replaces", () => {
    expect(PROTOTYPE_WEB_PAGE_BUNDLE_VERSION_MARK).toBe(PROTOTYPE_WEB_PAGE_VERSION_MARK);
    expect(PROTOTYPE_WEB_PAGE_BUNDLE_SOURCE).toContain(PROTOTYPE_WEB_PAGE_VERSION_MARK);
    const served = prototypeWebPageBundle();
    expect(served).not.toContain(PROTOTYPE_WEB_PAGE_VERSION_MARK);
    expect(served).toContain(JSON.stringify(version));
  });
});

describe("prototypeWebPageBundle", () => {
  test("puts the release version in place of every mark", () => {
    const source = `a="${PROTOTYPE_WEB_PAGE_VERSION_MARK}";b="${PROTOTYPE_WEB_PAGE_VERSION_MARK}"`;
    expect(prototypeWebPageBundle("1.2.3", source)).toBe('a="1.2.3";b="1.2.3"');
  });
});

describe("prototype-web export budget (#16528)", () => {
  test("is 500,000 bytes of minified HTML, JS and CSS", () => {
    expect(MAX_PROTOTYPE_WEB_EXPORT_BYTES).toBe(500_000);
  });

  test("allows an export at the budget", () => {
    expect(() => assertPrototypeWebExportBudget("page", 500_000)).not.toThrow();
  });

  test("refuses an export one byte over it", () => {
    expect(() => assertPrototypeWebExportBudget("page", 500_001)).toThrow(
      "prototype-web page is 500001 bytes minified, over the 500000-byte export budget",
    );
  });
});
