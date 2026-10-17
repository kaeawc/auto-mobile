import { describe, expect, test } from "bun:test";
import { probeProblems } from "../../scripts/docs/check-site-in-browser";

// Probe results shaped like headless-Chrome runs of the real 404.html builds:
// themed (site_url set) and unthemed (root-absolute assets 404).
const styled = {
  headerPosition: "sticky",
  headerDisplay: "block",
  headerHeight: 48,
  bodyFont: '"Shantell Sans", -apple-system, sans-serif',
  hasContent: true,
  sheets: [{ href: "/auto-mobile/assets/stylesheets/main.ec1eaa64.min.css", parsed: true }],
};
const unstyled = {
  headerPosition: "static",
  headerDisplay: "block",
  headerHeight: 20,
  bodyFont: "Times",
  hasContent: true,
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
