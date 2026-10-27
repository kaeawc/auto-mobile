import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import contract from "../../../schemas/prototype-spec-contract.json";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import {
  effectiveDesign,
  designFallbackPaths,
  prototypeDesignCoverage,
} from "../../../src/features/prototype/prototypeDesign";
import { prototypePlatformNotes } from "../../../src/features/prototype/prototypePlatformNotes";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";

test("design coverage covers exactly the node vocabulary", () => {
  const coverage = prototypeDesignCoverage;
  expect(Object.keys(coverage).sort()).toEqual(
    Object.keys(contract.definitions.node.variants).sort(),
  );
  for (const entry of Object.values(coverage)) {
    expect(["native", "material", "neutral"]).toContain(entry.ios);
    expect(["material", "neutral"]).toContain(entry.android);
  }
});

test("only explicit platform design requires capability", () => {
  expect(prototypeGateCapabilities({ theme: { design: "platform" } })).toEqual([
    "prototype_design_platform_v1",
  ]);
  expect(prototypeGateCapabilities({ theme: { design: "material" } })).toEqual([]);
  expect(prototypeGateCapabilities({})).toEqual([]);
});

const base = {
  id: "design",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text: "Hello" },
};

test("effective design defaults to platform and preserves explicit material", () => {
  expect(effectiveDesign(base)).toBe("platform");
  expect(effectiveDesign({ ...base, theme: { design: "material" } })).toBe("material");
  expect(effectiveDesign({ ...base, theme: { design: "platform" } })).toBe("platform");
  expect(designFallbackPaths({ ...base, root: { type: "switch" } })).toEqual([]);
  expect(
    designFallbackPaths({ ...base, theme: { design: "material" }, root: { type: "switch" } }),
  ).toEqual([]);
});

test("fallback paths traverse screens, repeat templates and component definitions without opaque payloads", () => {
  expect(
    designFallbackPaths({
      theme: { design: "platform" },
      root: {
        type: "stack",
        screens: {
          home: {
            type: "column",
            repeat: { items: [1] },
            children: [
              { type: "button", label: "Native" },
              {
                type: "switch",
                stateKey: "on",
                onTap: [{ type: "emit", payload: { type: "checkbox" } }],
              },
            ],
          },
        },
      },
      components: { Card: { root: { type: "card", children: [{ type: "textField" }] } } },
    }),
  ).toEqual([
    'root.screens["home"].children[1]',
    "components.Card.root",
    "components.Card.root.children[0]",
  ]);
});

test("native coverage is exactly today's SwiftUI control set", () => {
  expect(
    Object.entries(prototypeDesignCoverage)
      .filter(([, v]) => v.ios === "native")
      .map(([k]) => k)
      .sort(),
  ).toEqual(["button", "datePicker", "slider", "timePicker"]);
});

for (const doc of ["android/prototype-ux.md", "ios/prototype-agent.md"]) {
  test(`design coverage table in ${doc} matches the contract`, () => {
    const prose = readFileSync(
      new URL(`../../../docs/design-docs/plat/${doc}`, import.meta.url),
      "utf8",
    );
    const rows = prose
      .split("\n")
      .filter((line) => /^\|\s+\w+\s+\|\s+(native|material|neutral)\s+\|/.test(line));
    const expected = Object.entries(prototypeDesignCoverage)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([node, entry]) => [node, entry.ios, entry.android, entry.parts?.join(", ") || "—"]);
    expect(
      rows
        .map((row) =>
          row
            .split("|")
            .slice(1, -1)
            .map((cell) => cell.trim()),
        )
        .sort(([a], [b]) => a!.localeCompare(b!)),
    ).toEqual(expected);
  });
}

test("iOS design notes cap paths, Android and non-explicit designs stay silent", () => {
  const input = {
    ...base,
    theme: { design: "platform" },
    state: { on: true },
    root: {
      type: "column",
      children: Array.from({ length: 22 }, () => ({ type: "switch", stateKey: "on" })),
    },
  };
  const spec = prototypeSpecSchema.parse(input);
  const note = prototypePlatformNotes(spec, "ios", () => true).find(
    (note) => note.construct === "design.fallback",
  );
  expect(note).toEqual({
    platform: "ios",
    construct: "design.fallback",
    effect: "substituted",
    paths: Array.from({ length: 20 }, (_, i) => `root.children[${i}]`),
    total: 22,
    detail:
      "These nodes have no native iOS coverage yet and keep the Material drawing (see designCoverage).",
  });
  expect(prototypePlatformNotes(spec, "android", () => true)).toEqual([]);
  for (const theme of [undefined, { design: "material" }]) {
    expect(
      prototypePlatformNotes(
        prototypeSpecSchema.parse({ ...input, theme }),
        "ios",
        () => true,
      ).some((note) => note.construct === "design.fallback"),
    ).toBe(false);
  }
});
