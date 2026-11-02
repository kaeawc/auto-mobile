import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPrototypeWebPage,
  MAX_PROTOTYPE_WEB_RUNTIME_BYTES,
  PROTOTYPE_WEB_RUNTIME,
  type PrototypeWebPageInput,
} from "../../../../src/features/prototype/web/webPage";
import { prototypeWebZoomScale } from "../../../../src/features/prototype/web/webPageRuntime";

const reference = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../fixtures/prototype-web/reference-checkout.json"),
    "utf8",
  ),
) as Record<string, unknown>;
const tiny = (text: string) => ({
  id: "tiny",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text },
});
const input: PrototypeWebPageInput = {
  title: "Checkout <v2>",
  variants: [
    {
      id: "a",
      label: "Cart",
      revisions: [
        { revision: 1, operation: "show", spec: tiny("first") },
        { revision: 2, operation: "patch", spec: reference },
      ],
    },
    {
      id: "b",
      label: "One page",
      revisions: [{ revision: 1, operation: "show", spec: tiny("alt") }],
    },
  ],
};
const controls = (html: string) =>
  [...html.slice(0, html.indexOf("<script")).matchAll(/data-control="([^"]+)"/g)]
    .map((match) => match[1])
    .sort();

describe("prototype web page (#16346)", () => {
  const page = buildPrototypeWebPage(input);

  test("the same input yields the same bytes and hash", () => {
    const again = buildPrototypeWebPage(input);
    expect(again.html).toBe(page.html);
    expect(page.sha256).toBe(createHash("sha256").update(page.html).digest("hex"));
  });

  test("pins its only script by hash and loads nothing from the network", () => {
    const hash = createHash("sha256").update(PROTOTYPE_WEB_RUNTIME).digest("base64");
    expect(page.html).toContain(
      `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; font-src data:`,
    );
    expect(page.html.match(/<script/g)).toHaveLength(1);
    expect(page.html).not.toMatch(/\s(src|href)="(?!data:|#)/);
    expect(page.html).not.toMatch(/@import|url\((?!data:)/);
  });

  test("zooming out never enlarges a preview fitted below 50%", () => {
    expect(prototypeWebZoomScale(0.38, 0.38 / 1.25)).toBe(0.38);
    expect(prototypeWebZoomScale(1, 0.2)).toBe(0.5);
    expect(prototypeWebZoomScale(1, 9)).toBe(4);
    expect(prototypeWebZoomScale(0.38, 0.38 * 1.25)).toBeCloseTo(0.475);
  });

  test("keeps the runtime within its budget", () => {
    expect(Buffer.byteLength(PROTOTYPE_WEB_RUNTIME)).toBeLessThanOrEqual(
      MAX_PROTOTYPE_WEB_RUNTIME_BYTES,
    );
  });

  test("offers only rotate, zoom and pan, a variant switcher and revision history", () => {
    expect(controls(page.html)).toEqual([
      "revisions",
      "rotate",
      "variant",
      "zoom-fit",
      "zoom-in",
      "zoom-level",
      "zoom-out",
    ]);
  });

  test("hides the variant switcher with a single variant", () => {
    const single = buildPrototypeWebPage({ ...input, variants: [input.variants[1]!] });
    expect(controls(single.html)).not.toContain("variant");
  });

  test("pre-renders both orientations of every inlined revision and shows the latest first", () => {
    expect(page.inlinedRevisions).toEqual({ a: [2, 1], b: [1] });
    expect(page.html.match(/data-view=""/g)).toHaveLength(6);
    expect(page.html).toContain('<body data-variant="a" data-revision="2">');
    expect(page.html.match(/data-view="" hidden=""/g)).toHaveLength(5);
  });

  test("lists revisions newest first with the operation that made them", () => {
    const history = page.html.slice(page.html.indexOf('data-control="revisions"'));
    expect(history.indexOf("r2 · patch")).toBeLessThan(history.indexOf("r1 · show"));
  });

  test("escapes the title", () => {
    expect(page.html).toContain("<title>Checkout &lt;v2&gt;</title>");
  });

  test("reports the unsupported nodes of the view shown first", () => {
    expect(page.unsupportedNodes.map((node) => node.type)).toEqual(["progress"]);
  });

  test("drops older revisions to stay within the budget, keeping each variant's latest", () => {
    const small = buildPrototypeWebPage({ ...input, maxBytes: page.html.length - 1000 });
    expect(small.inlinedRevisions.a).toEqual([2]);
  });

  test("refuses when even the latest revisions do not fit, naming the largest view", () => {
    expect(() => buildPrototypeWebPage({ ...input, maxBytes: 10 * 1024 })).toThrow(
      /would exceed 10240 bytes even with only the latest revision of each variant\. Largest view: variant a revision 2/,
    );
  });

  test("an unknown variant lists the valid ones", () => {
    expect(() => buildPrototypeWebPage({ ...input, variant: "z" })).toThrow(
      'Unknown or empty prototype variant "z". Variants: a, b',
    );
  });
});
