import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { countRows, findDirectives, scanRepo } from "../../scripts/lib/oxlintDisableScan";

const rulesOf = (src: string) => findDirectives(src).map((d) => d.rules);

describe("oxlintDisableScan", () => {
  test("counts one directive per rule and normalises eslint/ prefix", () => {
    const [d] = findDirectives("// eslint-disable-next-line eslint/complexity, max-params -- why");
    expect(d.rules).toEqual(["complexity", "max-params"]);
    expect(d.hasReason).toBe(true);
  });

  test("flags reason-less directives and bare block directives", () => {
    const ds = findDirectives(
      "x(); // oxlint-disable-line max-depth\n/* eslint-disable */\n/* eslint-disable foo -- r */",
    );
    expect(ds.map((d) => [d.rules, d.hasReason])).toEqual([
      [["max-depth"], false],
      [["*"], false],
      [["foo"], true],
    ]);
  });

  test("ignores enable directives and directive text inside strings", () => {
    expect(
      findDirectives('/* eslint-enable foo */\nconst s = "// oxlint-disable-next-line a";'),
    ).toEqual([]);
  });

  test("counts a multi-line block directive", () => {
    expect(rulesOf("/*\n oxlint-disable no-debugger\n*/\ndebugger;")).toEqual([["no-debugger"]]);
  });

  test("counts a second comment on the same line", () => {
    expect(rulesOf("/* x */ // oxlint-disable-line a\nfoo();")).toEqual([["a"]]);
  });

  test("counts a directive after the closing line of a multi-line template", () => {
    expect(rulesOf("const t = `a\nb`; // oxlint-disable-line c\n")).toEqual([["c"]]);
  });

  test("counts a directive after a regex literal containing a quote", () => {
    expect(rulesOf("const r = /'/; // oxlint-disable-line d\n")).toEqual([["d"]]);
  });

  test("counts a directive on punctuation-only trailing positions", () => {
    expect(rulesOf("try {\n} catch (e) {\n  // oxlint-disable-next-line e\n}\n")).toEqual([["e"]]);
  });

  test("does not count directive-looking lines in block comments, JSDoc or templates", () => {
    expect(rulesOf("/* a\n// oxlint-disable-next-line x\n*/")).toEqual([]);
    expect(rulesOf("/**\n * oxlint-disable y\n */\nfoo();")).toEqual([]);
    expect(rulesOf("const t = `\n// oxlint-disable-next-line z\n`;")).toEqual([]);
  });

  test("reason separator follows ESLint: whitespace then two or more dashes", () => {
    const [a] = findDirectives("// oxlint-disable-next-line max-params --reason");
    expect(a.rules).toEqual(["max-params"]);
    expect(a.hasReason).toBe(true);
    const [b] = findDirectives("// oxlint-disable-next-line max-params ---- why");
    expect(b.rules).toEqual(["max-params"]);
    expect(b.hasReason).toBe(true);
    const [c] = findDirectives("// oxlint-disable-next-line max-params --");
    expect(c.hasReason).toBe(false);
  });

  test("countRows emits a no-reason row only for reason-less directives", () => {
    const counts = new Map<string, number>();
    countRows(
      "src/a.ts",
      "// oxlint-disable-next-line a\n// oxlint-disable-next-line a -- r",
      counts,
    );
    expect(counts.get("src/a.ts\toxlint-disable(a)")).toBe(2);
    expect(counts.get("src/a.ts\toxlint-disable-no-reason(a)")).toBe(1);
  });

  describe("scanRepo", () => {
    const walk = () => null;
    const D = "// oxlint-disable-next-line q -- r\n";
    const withRoot = (body: (root: string) => void) => {
      const root = mkdtempSync(join(tmpdir(), "oxscan-"));
      try {
        body(root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };
    const put = (root: string, rel: string, text: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };

    test("fails closed when no linted files exist", () => {
      withRoot((root) => {
        expect(() => scanRepo(root, walk)).toThrow(/no source files/);
        put(root, "a.js", D);
        expect(() => scanRepo(root, walk)).toThrow(/no source files/);
      });
    });

    test("counts TypeScript outside the old roots, skips JavaScript and ignorePatterns (JSONC)", () => {
      withRoot((root) => {
        put(root, "tools/deep/t.ts", D);
        put(root, "t.mts", D);
        put(root, "x.js", D);
        put(root, "vendor/v.ts", D);
        put(root, "src/gen/a.generated.ts", D);
        put(
          root,
          ".oxlintrc.json",
          '{ // c\n "ignorePatterns": ["vendor/**", "**/*.generated.ts", "**/*.js",],\n}\n',
        );
        expect(scanRepo(root, walk)).toBe(
          "1\tt.mts\toxlint-disable(q)\n1\ttools/deep/t.ts\toxlint-disable(q)\n",
        );
      });
    });

    test("with a git file list, skips deleted tracked files and applies the same filters", () => {
      withRoot((root) => {
        put(root, "new/u.ts", D);
        put(root, "new/u.js", D);
        const listed = () => ["new/u.ts", "new/u.js", "gone.ts"];
        expect(scanRepo(root, listed)).toBe("1\tnew/u.ts\toxlint-disable(q)\n");
      });
    });
  });
});
