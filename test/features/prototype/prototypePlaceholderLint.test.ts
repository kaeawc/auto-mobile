import { describe, expect, test } from "bun:test";
import {
  lintPrototypePlaceholders,
  prototypePlaceholderOutput,
} from "../../../src/features/prototype/prototypePlaceholderLint";

const spec = (root: unknown, extra: Record<string, unknown> = {}) => ({
  id: "lint",
  window: { placement: { type: "fullscreen" } },
  ...extra,
  root,
});
const paths = (value: unknown) =>
  lintPrototypePlaceholders(value).findings.map(
    ({ path, placeholder }) => `${path} ${placeholder}`,
  );

describe("prototype placeholder lint (#15444)", () => {
  test("a repeat placeholder in chip.label is found at the authored path", () => {
    const value = spec({
      type: "column",
      children: [
        {
          type: "column",
          repeat: { items: [{ text: "a" }], as: "r" },
          children: [
            { type: "chip", label: "{r.text}" },
            { type: "button", label: "{r.text}" },
            { type: "badge", text: "{index}" },
          ],
        },
      ],
    });

    expect(paths(value)).toEqual([
      "root.children[0].children[0].label {r.text}",
      "root.children[0].children[2].text {index}",
    ]);
  });

  test("a declared state placeholder in textField.placeholder is found, an undeclared brace is not", () => {
    const value = spec(
      {
        type: "column",
        children: [
          { type: "textField", stateKey: "draft", placeholder: "Message #{chName}" },
          { type: "textField", stateKey: "draft", placeholder: "Use {braces} freely" },
        ],
      },
      { state: { chName: "general", draft: "" } },
    );

    expect(paths(value)).toEqual(["root.children[0].placeholder {chName}"]);
  });

  test("a component props placeholder is found inside the component only", () => {
    const value = spec(
      { type: "chip", label: "{props.x}" },
      { components: { tag: { root: { type: "chip", label: "{props.x}" } } } },
    );

    expect(paths(value)).toEqual(["components.tag.root.label {props.x}"]);
  });

  test("a spec without such placeholders returns no findings and no output fields", () => {
    const value = spec({ type: "chip", label: "Plain" });

    expect(lintPrototypePlaceholders(value).findings).toEqual([]);
    expect(prototypePlaceholderOutput(value)).toEqual({});
  });

  test("the output carries the findings and caps the total", () => {
    const children = Array.from({ length: 60 }, () => ({ type: "badge", text: "{count}" }));
    const output = prototypePlaceholderOutput(
      spec({ type: "column", children }, { state: { count: 1 } }),
    );

    expect(output.placeholderFindings).toHaveLength(50);
    expect(output.placeholderFindingsTotal).toBe(60);
  });
});
