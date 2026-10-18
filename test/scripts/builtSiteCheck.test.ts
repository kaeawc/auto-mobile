import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkPage,
  collectReferences,
  formatViolation,
  normalizeBasePath,
  resolveSitePath,
} from "../../scripts/docs/built-site-check";

// Real MkDocs Material 404.html output: `broken` was built without `site_url`
// (root-absolute asset URLs), `fixed` with site_url set to the Pages URL.
const FIXTURES = join(import.meta.dir, "..", "fixtures", "docs-site");
const broken = readFileSync(join(FIXTURES, "404-broken-root-base.html"), "utf8");
const fixed = readFileSync(join(FIXTURES, "404-fixed-base.html"), "utf8");
const BASE = "/auto-mobile/";

describe("built site check", () => {
  test("flags every root-absolute asset in a 404 page built without site_url", async () => {
    const violations = await checkPage("404.html", broken, BASE, () => true);
    const urls = violations.map((v) => v.url);
    expect(urls).toContain("/assets/stylesheets/main.ec1eaa64.min.css");
    expect(urls.some((url) => url.startsWith("/assets/javascripts/bundle."))).toBe(true);
    expect(violations.every((v) => v.reason === "root-absolute-outside-base")).toBe(true);
    expect(formatViolation(violations[0])).toContain("resolves outside the site base path");
  });

  test("accepts a 404 page built with site_url when its assets exist", async () => {
    const seen: string[] = [];
    const violations = await checkPage("404.html", fixed, BASE, (path) => {
      seen.push(path);
      return true;
    });
    expect(violations).toEqual([]);
    expect(seen).toContain("assets/stylesheets/main.ec1eaa64.min.css");
  });

  test("reports a stylesheet or script missing from the build output", async () => {
    const violations = await checkPage("404.html", fixed, BASE, () => false);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.reason === "missing-file")).toBe(true);
    expect(violations.map((v) => v.tag)).toContain("script");
  });

  test("ignores external, fragment and data URLs", async () => {
    const html =
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css"><a href="#top">t</a>' +
      '<script src="//cdn.example/x.js"></script><img src="data:image/png;base64,AA">';
    expect(await checkPage("index.html", html, BASE, () => false)).toEqual([]);
  });

  test("resolves relative URLs against the page directory", async () => {
    expect(resolveSitePath("using/ui-tests/index.html", "../../assets/a.css", BASE)).toBe(
      "assets/a.css",
    );
    expect(resolveSitePath("index.html", "tools/", BASE)).toBe("tools/index.html");
    expect(resolveSitePath("index.html", "/auto-mobile/img/a.png", BASE)).toBe("img/a.png");
    expect(resolveSitePath("index.html", "/img/a.png", BASE)).toBeNull();
    expect(resolveSitePath("a/index.html", "../../../x.css", BASE)).toBeNull();
  });

  test("collects references by element", async () => {
    const refs = await collectReferences('<a href="x/">x</a><script src="s.js"></script>');
    expect(refs).toEqual([
      { tag: "a", url: "x/", mustExist: false },
      { tag: "script", url: "s.js", mustExist: true },
    ]);
  });

  test("normalizes base paths", () => {
    expect(normalizeBasePath("auto-mobile")).toBe("/auto-mobile/");
    expect(normalizeBasePath("/")).toBe("/");
  });
});
