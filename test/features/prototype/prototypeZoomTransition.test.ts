import { expect, test } from "bun:test";
import {
  PROTOTYPE_ZOOM_RENDERING_GATE,
  prototypeZoomTransitionNotes,
} from "../../../src/features/prototype/prototypeZoomTransition";
import { requiredPrototypeCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { prototypePlatformNotes } from "../../../src/features/prototype/prototypePlatformNotes";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { readFileSync } from "node:fs";

const zoom = JSON.parse(
  readFileSync(
    new URL("../../fixtures/prototype-spec/valid/stack-patterns-zoom.json", import.meta.url),
    "utf8",
  ),
);
const capability = "prototype_zoom_transition_v1";

for (const platform of ["android", "ios"] as const) {
  test(`${platform} zoom rendering promise does not change the authoring gate`, () => {
    const required = requiredPrototypeCapabilities(zoom);
    expect(required).toContain("prototype_stack_patterns_v1");
    expect(required).not.toContain(capability);
    expect(validatePrototypeSpec(zoom, { supportedCapabilities: required }).success).toBe(true);
    expect(prototypeZoomTransitionNotes(zoom, platform, () => false)).toHaveLength(1);
    expect(prototypeZoomTransitionNotes(zoom, platform, () => true, 18)).toEqual([]);
  });
}

test("iOS 17 fallback includes the discovered OS and survives an inconsistent advertisement", () => {
  const notes = prototypePlatformNotes(zoom, "ios", () => true, 17);
  expect(notes.find(({ construct }) => construct === "stack.zoom")?.detail).toContain(
    "device iOS 17",
  );
  expect(
    prototypePlatformNotes(zoom, "ios", () => true, 18).some(({ detail }) =>
      detail.includes("falls back"),
    ),
  ).toBe(false);
});

test("fallback is capped and absent for non-zoom patterns", () => {
  const root = { type: "stack", transition: "sharedAxisX", screens: { home: { type: "text" } } };
  expect(prototypeZoomTransitionNotes({ root }, "ios", () => false, 17)).toEqual([]);
  const notes = prototypeZoomTransitionNotes(
    {
      root: {
        type: "column",
        children: Array.from({ length: 23 }, () => ({ ...root, transition: "zoom" })),
      },
    },
    "android",
    () => false,
  );
  expect(notes[0]?.paths).toHaveLength(20);
  expect(notes[0]?.total).toBe(23);
});

const feature = {
  type: "text",
  onTap: [{ type: "push", stack: "nav", screen: "detail", transition: "zoom", source: "hero" }],
};
const containers: Record<string, unknown> = {
  root: { root: feature },
  child: { root: { type: "scroll", child: feature } },
  children: { root: { type: "column", children: [feature] } },
  header: { root: { type: "list", header: feature } },
  footer: { root: { type: "list", footer: feature } },
  screens: { root: { type: "stack", screens: { home: feature } } },
  component: { root: { type: "text" }, components: { Hero: { root: feature } } },
};
for (const [name, spec] of Object.entries(containers)) {
  test(`zoom rendering gate covers ${name}`, () => {
    expect(PROTOTYPE_ZOOM_RENDERING_GATE.fields(spec)).toHaveLength(1);
  });
}
