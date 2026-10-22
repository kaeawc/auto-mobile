import { describe, expect, test } from "bun:test";
import {
  MAX_PROTOTYPE_ACCESSIBILITY_FINDINGS,
  lintPrototypeAccessibility,
  prototypeAccessibilityOutput,
} from "../../../src/features/prototype/prototypeAccessibilityLint";
import {
  contrastRatio,
  parsePrototypeHex,
  prototypeRolePalette,
  resolvePrototypeColor,
} from "../../../src/features/prototype/prototypeContrast";

const spec = (root: unknown, theme?: unknown) => ({
  id: "lint",
  window: { placement: { type: "fullscreen" } },
  ...(theme ? { theme } : {}),
  root,
});
const column = (...children: unknown[]) => ({ type: "column", children });
const rules = (value: unknown) =>
  lintPrototypeAccessibility(value).findings.map(({ rule, path }) => `${rule} ${path}`);

describe("prototype accessibility lint (#14126)", () => {
  test("an interactive node without any name is unlabeled-control", () => {
    expect(
      rules(
        spec(
          column(
            { type: "iconButton", icon: "close" },
            { type: "iconButton", icon: "close", contentDescription: "Close" },
            {
              type: "box",
              onTap: [{ type: "emit", name: "x" }],
              child: { type: "icon", name: "add" },
            },
            {
              type: "row",
              onTap: [{ type: "emit", name: "y" }],
              children: [{ type: "text", text: "Open" }],
            },
            { type: "switch", stateKey: "on" },
            { type: "fab", icon: "add", label: "New" },
          ),
        ),
      ),
    ).toEqual([
      "unlabeled-control root.children[0]",
      "unlabeled-control root.children[2]",
      "unlabeled-control root.children[4]",
    ]);
  });

  test("only an exposed image or icon needs a description; a plain one is decorative", () => {
    expect(
      rules(
        spec(
          column(
            { type: "image", asset: "hero" },
            { type: "image", asset: "hero", testTag: "hero" },
            { type: "icon", name: "star", testTag: "star", contentDescription: "Starred" },
          ),
        ),
      ),
    ).toEqual(["unlabeled-image root.children[1]"]);
  });

  test("text fields need a label, placeholder or description", () => {
    expect(
      rules(
        spec(
          column(
            { type: "textField", stateKey: "email" },
            { type: "textField", stateKey: "name", placeholder: "Name" },
            { type: "searchBar", stateKey: "q" },
          ),
        ),
      ),
    ).toEqual(["unlabeled-text-field root.children[0]", "unlabeled-text-field root.children[2]"]);
  });

  test("an authored tap target under 48dp is small; sizes left to layout are not checked", () => {
    const { findings } = lintPrototypeAccessibility(
      spec(
        column(
          {
            type: "iconButton",
            icon: "close",
            contentDescription: "Close",
            style: { width: { dp: 32 }, height: { dp: 32 } },
          },
          { type: "button", label: "OK", style: { height: { dp: 48 } } },
          { type: "button", label: "Go", style: { width: "fill" } },
          { type: "box", style: { width: { dp: 10 } } },
        ),
      ),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        rule: "small-touch-target",
        path: "root.children[0]",
        value: 32,
        minimum: 48,
      }),
    ]);
  });

  test("text contrast is checked against the resolved background in light and dark", () => {
    const { findings } = lintPrototypeAccessibility(
      spec(
        column(
          { type: "text", text: "Faint", style: { color: "#BBBBBB" } },
          { type: "text", text: "Body", style: { color: "onSurface" } },
          {
            type: "box",
            style: { background: { light: "#FFFFFF", dark: "#333333" } },
            child: { type: "text", text: "Grey", style: { color: "#777777" } },
          },
        ),
      ),
    );
    expect(findings.map(({ path, mode, minimum }) => `${path} ${mode} ${minimum}`)).toEqual([
      "root.children[0] light 4.5",
      // #777777 is 4.48:1 on white and 2.82:1 on #333333.
      "root.children[2].child light 4.5",
      "root.children[2].child dark 4.5",
    ]);
    expect(findings[0]!.value).toBeLessThan(4.5);
  });

  test("large text needs 3:1, and a pinned theme mode checks only that mode", () => {
    // #8A8A8A is about 3.3:1 on the light baseline surface: enough for large text only.
    const large = { type: "text", text: "Title", style: { color: "#8A8A8A", textSize: 28 } };
    expect(rules(spec(large))).toEqual([]);
    expect(rules(spec({ ...large, style: { color: "#8A8A8A" } }))).toEqual(["low-contrast root"]);
    expect(
      lintPrototypeAccessibility(
        spec({ type: "text", text: "x", style: { color: "#FFFFFF" } }, { mode: "dark" }),
      ).findings,
    ).toEqual([]);
    expect(
      lintPrototypeAccessibility(
        spec({ type: "text", text: "x", style: { color: "#FFFFFF" } }, { mode: "light" }),
      ).findings.map(({ mode }) => mode),
    ).toEqual(["light"]);
  });

  test("role overrides apply; a seeded scheme leaves unoverridden roles unchecked", () => {
    const text = { type: "text", text: "x", style: { color: "primary" } };
    expect(rules(spec(text, { mode: "light", colors: { primary: "#FAFAFA" } }))).toEqual([
      "low-contrast root",
    ]);
    expect(rules(spec(text, { mode: "light", colors: { seed: "#FAFAFA" } }))).toEqual([]);
  });

  test("an unknown background (gradient, component surface, translucent over unknown) is skipped", () => {
    const faint = { type: "text", text: "x", style: { color: "#EEEEEE" } };
    expect(
      rules(
        spec(
          column(
            {
              type: "box",
              style: {
                gradient: { type: "linear", stops: [{ color: "#000000" }, { color: "#FFFFFF" }] },
              },
              child: faint,
            },
            { type: "card", children: [faint] },
          ),
          { mode: "light" },
        ),
      ),
    ).toEqual([]);
  });

  test("the output caps findings and reports the total", () => {
    const many = column(
      ...Array.from({ length: MAX_PROTOTYPE_ACCESSIBILITY_FINDINGS + 5 }, () => ({
        type: "iconButton",
        icon: "close",
      })),
    );
    const output = prototypeAccessibilityOutput(spec(many));
    expect(output.accessibilityFindings).toHaveLength(MAX_PROTOTYPE_ACCESSIBILITY_FINDINGS);
    expect(output.accessibilityFindingsTotal).toBe(MAX_PROTOTYPE_ACCESSIBILITY_FINDINGS + 5);
    expect(prototypeAccessibilityOutput(spec({ type: "text", text: "fine" }))).toEqual({});
  });
});

describe("components", () => {
  test("a finding inside a used component is reported at its authored path", () => {
    const withComponent = {
      ...spec(column({ type: "use", component: "close", props: {} })),
      components: { close: { root: { type: "iconButton", icon: "close" } } },
    };

    const { accessibilityFindings } = prototypeAccessibilityOutput(withComponent);

    expect(accessibilityFindings).toEqual([expect.objectContaining({ rule: "unlabeled-control" })]);
    expect(accessibilityFindings![0]!.path).toContain("use close");
    expect(accessibilityFindings![0]!.path).toContain("components.close.root");
  });
});

describe("prototype contrast helpers", () => {
  test("parses Android-style hex and computes WCAG ratios", () => {
    expect(parsePrototypeHex("#80FF0000")).toEqual({ r: 255, g: 0, b: 0, a: 128 / 255 });
    expect(parsePrototypeHex("red")).toBeUndefined();
    const ratio = contrastRatio(parsePrototypeHex("#000000")!, parsePrototypeHex("#FFFFFF")!);
    expect(ratio).toBeCloseTo(21, 5);
  });

  test("resolves roles from the baseline per mode and pairs by mode", () => {
    const light = prototypeRolePalette({}, "light");
    expect(resolvePrototypeColor("onSurface", "light", light)).toEqual(
      parsePrototypeHex("#1D1B20"),
    );
    expect(
      resolvePrototypeColor(
        { light: "#010203", dark: "primary" },
        "dark",
        prototypeRolePalette({}, "dark"),
      ),
    ).toEqual(parsePrototypeHex("#D0BCFF"));
  });
});

describe("baseline palette parity", () => {
  test("matches the iOS prototype agent's Material 3 baseline tables", async () => {
    const swift = await Bun.file(
      "ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore/PrototypeTheme.swift",
    ).text();
    for (const mode of ["light", "dark"] as const) {
      const name = mode === "light" ? "baselineLight" : "baselineDark";
      const block = swift.slice(swift.indexOf(`static let ${name} = table([`));
      const body = block.slice(0, block.indexOf("])"));
      const entries = [...body.matchAll(/"(\w+)": 0x([0-9A-Fa-f]{6})/g)];
      expect(entries.length).toBeGreaterThan(30);
      const palette = prototypeRolePalette({}, mode);
      for (const [, role, hex] of entries) {
        expect([role, palette.get(role!)]).toEqual([role, parsePrototypeHex(`#${hex}`)]);
      }
      expect(palette.size).toBe(entries.length);
    }
  });
});
