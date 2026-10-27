import { prototypeSpecForDevice } from "../../../src/features/prototype/prototypeComponents";
import { applyPrototypePatch } from "../../../src/features/prototype/prototypePatch";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import { prototypePlatformNotes } from "../../../src/features/prototype/prototypePlatformNotes";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { prototypeDesignCoverage } from "../../../src/features/prototype/prototypeDesign";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../fixtures/prototype-spec/valid/adaptive-${name}.json`, import.meta.url),
      "utf8",
    ),
  );

for (const kind of ["list-detail", "navigation-suite", "supporting"]) {
  test(`adaptive ${kind} parses, gates and reports native differences on both platforms`, () => {
    const raw = fixture(kind);
    expect(validatePrototypeSpec(raw).success).toBe(true);
    const spec = prototypeSpecSchema.parse(raw);
    expect(prototypeGateCapabilities(spec)).toEqual(["prototype_adaptive_v1"]);
    for (const platform of ["android", "ios"] as const) {
      const note = prototypePlatformNotes(spec, platform, () => true).find(
        (note) => note.construct === "adaptive",
      );
      expect(note?.paths).toEqual(["root"]);
      expect(note?.detail).toContain("compact/medium/expanded");
      expect(note?.detail).toContain("horizontalSizeClass");
    }
  });
}

test("adaptive covers Material drawing on both platforms", () => {
  expect(prototypeDesignCoverage.adaptive).toEqual({ ios: "material", android: "material" });
});

test("nested pane capability and notes retain authored paths", () => {
  const raw = fixture("nested");
  raw.root.detail.supporting = {
    type: "drawer",
    edge: "start",
    openWhen: { key: "open", equals: true },
    child: { type: "text", text: "Drawer" },
  };
  expect(prototypeGateCapabilities(raw)).toContain("prototype_drawer_v1");
  const spec = prototypeSpecSchema.parse(raw);
  const note = prototypePlatformNotes(spec, "android", () => true).find(
    (note) => note.construct === "adaptive",
  );
  expect(note?.paths).toEqual(["root", "root.detail"]);
});

test("adaptive slots expand component roots and bind their props", () => {
  const raw = fixture("list-detail");
  raw.components = { Pane: { root: { type: "text", text: "{props.title}" } } };
  raw.root.list = { type: "use", component: "Pane", props: { title: "Inbox" } };
  expect(validatePrototypeSpec(raw).success).toBe(true);
});

test("an adaptive component binds props inside every pane", () => {
  const raw = fixture("list-detail");
  raw.components = {
    Layout: { root: { ...raw.root, list: { type: "text", text: "{props.title}" } } },
  };
  raw.root = { type: "use", component: "Layout", props: { title: "Inbox" } };
  expect(prototypeSpecForDevice(raw)).toMatchObject({
    root: { type: "adaptive", list: { text: "Inbox" } },
  });
});

test("replaceNode reaches an adaptive slot and state patches preserve binding types", () => {
  const raw = fixture("list-detail");
  raw.root.detail.id = "detail";
  const result = applyPrototypePatch(raw, [
    { op: "replaceNode", id: "detail", node: { type: "text", id: "detail", text: "Updated" } },
  ]);
  expect(result).toMatchObject({ success: true });
  const statePatch = applyPrototypePatch(raw, [
    { op: "replace", path: "/state/selection", value: true },
  ]);
  expect(statePatch.success).toBe(true);
  if (statePatch.success) {
    expect(validatePrototypeSpec(statePatch.spec).success).toBe(false);
  }
});
