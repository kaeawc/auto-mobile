import { describe, expect, test } from "bun:test";
import {
  PSEUDO_LOCALE_EXPANSION,
  pseudoLocalizeSpec,
  pseudoLocalizeText,
} from "../../../src/features/prototype/prototypePseudoLocale";
import { prototypeLinkifyMatches } from "../../../src/features/prototype/prototypeLinkify";

describe("pseudo-locale text (#14126)", () => {
  test("accents, brackets and pads to about 140%", () => {
    const out = pseudoLocalizeText("Save changes");
    expect(out.startsWith("[Šáṽé çĥáñğéš")).toBe(true);
    expect(out.endsWith("~~~~~]")).toBe(true);
    expect([...out].length - 2).toBeGreaterThanOrEqual(12 * (1 + PSEUDO_LOCALE_EXPANSION));
  });

  test("leaves bindings and blank text alone", () => {
    expect(pseudoLocalizeText("Hi {data:/user/name}!")).toContain("{data:/user/name}");
    expect(pseudoLocalizeText("{item.title}")).toContain("{item.title}");
    expect(pseudoLocalizeText("  ")).toBe("  ");
  });
});

describe("pseudo-locale structure (#14126)", () => {
  test("linkified text keeps its link tokens detectable", () => {
    const out = pseudoLocalizeSpec({
      type: "text",
      text: "Visit https://example.com or @sam now",
      linkify: { kinds: ["url", "mention"], onTap: [] },
    });
    expect(
      prototypeLinkifyMatches(out.text, ["url", "mention"]).map((match) => match.text),
    ).toEqual(["https://example.com", "@sam"]);
    expect(out.text.startsWith("Ṽíšíť ")).toBe(true);
  });

  test("a screen or component named like an opaque field is still transformed", () => {
    const out = pseudoLocalizeSpec({
      screens: { theme: { type: "text", text: "Hello" }, data: { type: "text", text: "Bye" } },
      components: { state: { root: { type: "text", text: "Hi" } } },
    });
    expect(out.screens.theme.text).toContain("Ĥéļļó");
    expect(out.screens.data.text).toContain("Ɓýé");
    expect(out.components.state.root.text).toContain("Ĥí");
  });
});

describe("pseudo-locale spec", () => {
  const spec = {
    id: "p",
    state: { label: "keep" },
    root: {
      type: "column",
      children: [
        { type: "text", text: "Hello", style: { textStyle: "bodyLarge" } },
        { type: "text", spans: [{ text: "Bold" }] },
        {
          type: "button",
          label: "OK",
          onTap: [{ type: "emit", name: "go", context: { label: "x" } }],
        },
        { type: "select", stateKey: "s", options: [{ value: "a", label: "Alpha" }] },
        { type: "iconButton", icon: "close", contentDescription: "Close" },
        { type: "listItem", headline: "Name", supporting: "Description" },
        { type: "tabBar", items: [{ label: "Home" }] },
        { type: "row", repeat: { items: [{ label: "Raw" }], key: "label" } },
        { type: "box", onTap: [{ type: "emit", name: "e", payload: { title: "stable-id" } }] },
      ],
    },
  };

  test("transforms display text only, without mutating the input", () => {
    const copy = structuredClone(spec);
    const out = pseudoLocalizeSpec(spec) as typeof spec;
    expect(spec).toEqual(copy);
    const [text, spans, button, select, icon] = out.root.children as Record<string, any>[];
    expect(text.text).toContain("Ĥéļļó");
    expect(text.style).toEqual({ textStyle: "bodyLarge" });
    expect(spans.spans[0].text).toContain("Ɓóļď");
    expect(button.label).toContain("ÓŔ".slice(0, 1));
    expect(button.onTap[0].context).toEqual({ label: "x" });
    expect(select.options[0]).toEqual({ value: "a", label: expect.stringContaining("Áļþĥá") });
    expect(icon.contentDescription).toBe("Close");
    expect(out.state).toEqual({ label: "keep" });
    const [, , , , , listItem, tabBar, repeated, emitting] = out.root.children as Record<
      string,
      any
    >[];
    expect(listItem.supporting).toContain("Ďéšçŕ");
    expect(tabBar.items[0].label).toContain("Ĥóɱé");
    expect(repeated.repeat).toEqual({ items: [{ label: "Raw" }], key: "label" });
    expect(emitting.onTap[0].payload).toEqual({ title: "stable-id" });
  });
});
