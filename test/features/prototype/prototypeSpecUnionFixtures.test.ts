import { expect, test } from "bun:test";
import contract from "../../../schemas/prototype-spec-contract.json";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import fixtures from "../../fixtures/prototype-spec/models.json";

const unionFixtures = Object.entries(fixtures).filter(([name]) => /^(node|action)/.test(name));
for (const [name, value] of unionFixtures) {
  test(`migrated ${name} satisfies the existing contract interpreter`, () => {
    const spec = {
      id: "models",
      requires: { platform: ["test", "clipboard", "media", "map"] },
      requires: { platform: ["test", "clipboard", "media", "cast"] },
      state: {
        enabled: true,
        text: "Text",
        count: 1,
        choice: "a",
        hour: 12,
        minute: 30,
        date: "2026-10-26",
        status: "idle",
      },
      data: { points: [{ value: 1 }], items: [], value: 1 },
      media: { players: { main: { kind: "video", source: { sample: "countdown" } } } },
      window: { placement: { type: "fullscreen" }, opacity: 100 },
      root: {
        type: "column",
        children: [
          name === "nodeBoxFilled"
            ? { type: "grid", columns: 2, children: [value] }
            : name.startsWith("node")
              ? value
              : { type: "button", label: "Go", onTap: [value] },
          { type: "pager", id: "targetPager", children: [{ type: "spacer" }] },
          {
            type: "stack",
            id: "targetStack",
            start: "home",
            screens: { home: { type: "spacer" } },
          },
          { type: "scroll", id: "targetScroll", child: { type: "spacer" } },
          {
            type: "textField",
            stateKey: "text",
            checks: [{ required: true, message: "Required" }],
          },
        ],
      },
    };
    expect<unknown>(validatePrototypeSpec(spec)).toMatchObject({ success: true });
  });
}

test("fixtures cover every action and node variant and every filled field", () => {
  for (const kind of ["action", "node"] as const) {
    const names = unionFixtures
      .filter(([name]) => name.startsWith(kind))
      .map(([, value]) => ("type" in value ? value.type : undefined));
    expect([...new Set(names)].sort()).toEqual(
      Object.keys(contract.definitions[kind].variants).sort(),
    );
  }
  for (const [rule, value] of [
    [contract.definitions.node.variants.box, fixtures.nodeBoxFilled],
    [contract.definitions.action.variants.request, fixtures.actionRequestFilled],
    [contract.definitions.action.variants.emit, fixtures.actionEmitFilled],
  ] as const) {
    // Cross-node constraints (a shared pair, a scroll source) cannot hold on one lone filled node,
    // and platform namespaces are stripped before the typed Kotlin decode (#15257).
    const crossNode = new Set([
      "shared",
      "sharedKey",
      "scrollLinked",
      "scrollTransition",
      "ios",
      "android",
    ]);
    expect(Object.keys(value).sort()).toEqual(
      Object.keys(rule.fields)
        .filter((field) => !crossNode.has(field))
        .sort(),
    );
  }
});
