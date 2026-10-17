import { describe, expect, test } from "bun:test";
import { probeProblems, redirectProblems } from "../../scripts/docs/check-site-in-browser";

// Probe results shaped like headless-Chrome runs of the real 404.html builds:
// themed (site_url set) and unthemed (root-absolute assets 404).
const styled = {
  headerPosition: "sticky",
  headerDisplay: "block",
  headerHeight: 48,
  bodyFont: '"Shantell Sans", -apple-system, sans-serif',
  hasContent: true,
  isNotFoundPage: false,
  finalUrl: "http://127.0.0.1:1/auto-mobile/",
  sheets: [{ href: "/auto-mobile/assets/stylesheets/main.ec1eaa64.min.css", parsed: true }],
};
const unstyled = {
  headerPosition: "static",
  headerDisplay: "block",
  headerHeight: 20,
  bodyFont: "Times",
  hasContent: true,
  isNotFoundPage: true,
  finalUrl: "http://127.0.0.1:1/auto-mobile/missing/",
  sheets: [{ href: "/assets/stylesheets/main.ec1eaa64.min.css", parsed: false }],
};

describe("probeProblems", () => {
  test("accepts a themed page", () => {
    expect(probeProblems(styled)).toEqual([]);
  });

  test("rejects the unstyled page", () => {
    const problems = probeProblems(unstyled).join("\n");
    expect(problems).toContain("position is static");
    expect(problems).toContain("Shantell Sans");
    expect(problems).toContain("did not load");
  });

  test("rejects a page with no Material layout", () => {
    const problems = probeProblems({
      ...unstyled,
      headerPosition: null,
      headerDisplay: null,
      headerHeight: null,
      hasContent: false,
      sheets: [],
    });
    expect(problems.length).toBe(4);
  });
});

describe("redirectProblems", () => {
  const home = "http://127.0.0.1:1/auto-mobile/";

  test("accepts a dead URL that landed on the home page", () => {
    expect(redirectProblems(styled, home)).toEqual([]);
  });

  test("rejects a dead URL that stayed on the 404 page", () => {
    const problems = redirectProblems(unstyled, home).join("\n");
    expect(problems).toContain("redirected to http://127.0.0.1:1/auto-mobile/missing/");
    expect(problems).toContain("still showing the 404 page");
  });

  test("rejects a redirect to the wrong page", () => {
    const wrong = { ...styled, finalUrl: `${home}tools/` };
    expect(redirectProblems(wrong, home)).toHaveLength(1);
  });
});
