import { describe, expect, test } from "bun:test";
import {
  MAX_PROTOTYPE_PLACEHOLDER_FINDINGS,
  lintPrototypePlaceholders,
  prototypePlaceholderOutput,
} from "../../../src/features/prototype/prototypePlaceholderLint";

const spec = (root: unknown, extra: Record<string, unknown> = {}) => ({
  id: "lint",
  window: { placement: { type: "fullscreen" } },
  root,
  ...extra,
});
const items = [{ name: "Alpha" }, { name: "Beta" }];
const repeating = (...children: unknown[]) => ({
  type: "column",
  repeat: { items, as: "item" },
  children,
});
const found = (value: unknown) =>
  lintPrototypePlaceholders(value).findings.map(
    ({ path, placeholder }) => `${path} ${placeholder}`,
  );

describe("prototype placeholder lint (#15444)", () => {
  test("a repeat placeholder in chip.label and badge.text is found at the field path", () => {
    expect(
      found(
        spec(repeating({ type: "chip", label: "{item.name}" }, { type: "badge", text: "{index}" })),
      ),
    ).toEqual(["root.children[0].label {item.name}", "root.children[1].text {index}"]);
  });

  test("fields that bind, and text nodes, are not reported", () => {
    expect(
      found(
        spec(
          repeating(
            { type: "button", label: "{item.name}" },
            { type: "text", text: "{index}: {item.name}" },
            { type: "searchBar", placeholder: "Find {item.name}", stateKey: "q" },
          ),
          { state: { q: "" } },
        ),
      ),
    ).toEqual([]);
  });

  test("a state placeholder in textField.placeholder is found, in topAppBar.title it is not", () => {
    const state = { chName: "general", draft: "" };
    expect(
      found(
        spec(
          {
            type: "column",
            children: [
              { type: "topAppBar", title: "#{chName}" },
              { type: "textField", stateKey: "draft", placeholder: "Message #{chName}" },
            ],
          },
          { state },
        ),
      ),
    ).toEqual(["root.children[1].placeholder {chName}"]);
  });

  test("a repeat placeholder in textField.placeholder inside a repeat is found", () => {
    expect(
      found(
        spec(repeating({ type: "textField", stateKey: "d", placeholder: "{item.name}" }), {
          state: { d: "" },
        }),
      ),
    ).toEqual(["root.children[0].placeholder {item.name}"]);
  });

  test("an unknown alias, an undeclared key, plain braces and a placeholder outside a repeat are literal text", () => {
    expect(
      found(
        spec(
          repeating(
            { type: "chip", label: "{other.name}" },
            { type: "chip", label: "{undeclared}" },
            { type: "badge", text: "{}" },
          ),
        ),
      ),
    ).toEqual([]);
    expect(found(spec({ type: "chip", label: "{item.name}" }))).toEqual([]);
    expect(found(spec({ type: "chip", label: "{index}" }))).toEqual([]);
  });

  test("the repeat container's own fields are outside its template scope", () => {
    expect(
      found(
        spec({ ...repeating({ type: "text", text: "x" }), type: "chip", label: "{item.name}" }),
      ),
    ).toEqual([]);
  });

  test("a spec without placeholders returns no findings and an empty output", () => {
    const clean = spec({ type: "column", children: [{ type: "chip", label: "Plain" }] });
    expect(lintPrototypePlaceholders(clean)).toEqual({ findings: [], total: 0 });
    expect(prototypePlaceholderOutput(clean)).toEqual({});
  });

  test("the output caps findings and reports the total", () => {
    const many = spec(
      repeating(
        ...Array.from({ length: MAX_PROTOTYPE_PLACEHOLDER_FINDINGS + 5 }, () => ({
          type: "chip",
          label: "{item.name}",
        })),
      ),
    );
    const output = prototypePlaceholderOutput(many);
    expect(output.placeholderFindings).toHaveLength(MAX_PROTOTYPE_PLACEHOLDER_FINDINGS);
    expect(output.placeholderFindingsTotal).toBe(MAX_PROTOTYPE_PLACEHOLDER_FINDINGS + 5);
  });
});
