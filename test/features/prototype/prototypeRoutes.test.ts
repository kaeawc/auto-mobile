import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";

const directory = new URL("../../fixtures/prototype-spec/", import.meta.url);
const invalid = readdirSync(new URL("invalid/", directory))
  .filter((name) => name.startsWith("routes-"))
  .map((name) => ({
    name,
    fixture: JSON.parse(readFileSync(new URL(`invalid/${name}`, directory), "utf8")),
  }));
for (const { name, fixture } of invalid) {
  test(`route contract ${name}`, () => {
    const result = validatePrototypeSpec(fixture.spec, {
      ...fixture.options,
      requiredCapabilities: prototypeGateCapabilities,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.path).toBe(fixture.expectedPath);
      if (fixture.expectedMessage) expect(result.error.message).toBe(fixture.expectedMessage);
    }
  });
}

for (const action of [
  { type: "push", stack: "nav", screen: "home", params: {} },
  { type: "replace", stack: "nav", screen: "home", params: {} },
  { type: "pop", stack: "nav", force: false },
  { type: "setStack", stack: "nav", path: [{ screen: "home" }] },
]) {
  test(`${action.type} route fields require the route capability`, () => {
    expect(
      prototypeGateCapabilities({ root: { type: "text", text: "x", onTap: [action] } }),
    ).toContain("prototype_routes_v1");
  });
}

test("opaque route-looking payloads do not require the route capability", () => {
  expect(
    prototypeGateCapabilities({
      root: {
        type: "text",
        text: "x",
        onTap: [
          {
            type: "emit",
            name: "opaque",
            payload: { type: "setStack", text: "{route.id}", params: {} },
          },
        ],
      },
    }),
  ).not.toContain("prototype_routes_v1");
});

test("route validation scales across 60 stacks with 32 screens each", async () => {
  const { prototypeRoutesError } = await import("../../../src/features/prototype/prototypeRoutes");
  const { walkPrototypeNodes } =
    await import("../../../src/features/prototype/prototypeNodeChildren");
  const spec = {
    root: {
      type: "column",
      children: Array.from({ length: 60 }, (_, stack) => ({
        type: "stack",
        id: `nav${stack}`,
        start: "s0",
        routes: {},
        screens: Object.fromEntries(
          Array.from({ length: 32 }, (_, screen) => [
            `s${screen}`,
            { type: "text", text: "x", visibleWhen: { key: "k", equals: "x" } },
          ]),
        ),
      })),
    },
  };
  const nodes: { value: Record<string, unknown>; path: string }[] = [];
  walkPrototypeNodes(spec, (value, path) => nodes.push({ value, path }));
  const started = performance.now();
  expect(prototypeRoutesError(spec, nodes, [])).toBeUndefined();
  expect(performance.now() - started).toBeLessThan(1000);
});
