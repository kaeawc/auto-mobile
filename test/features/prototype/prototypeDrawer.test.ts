import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import {
  prototypeDrawerFields,
  prototypeDrawerUnsupportedMessage,
} from "../../../src/features/prototype/prototypeDrawer";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";

const drawer = {
  type: "drawer",
  edge: "end",
  openWhen: { key: "open", equals: true },
  child: { type: "text", text: "Navigation" },
};
const spec = (root: object) => ({
  id: "drawer",
  window: { placement: { type: "fullscreen" } },
  state: { open: true },
  root,
});
const directory = new URL("../../fixtures/prototype-spec/invalid/", import.meta.url);
for (const name of readdirSync(directory).filter((name) => name.startsWith("tooltip-drawer-"))) {
  const fixture: { spec: unknown; expectedPath: string; expectedMessage: string } = JSON.parse(
    readFileSync(new URL(name, directory), "utf8"),
  );
  test(`shared drawer rejection: ${name}`, () => {
    expect(validatePrototypeSpec(fixture.spec)).toMatchObject({
      success: false,
      error: { path: fixture.expectedPath, message: fixture.expectedMessage },
    });
  });
}

test("drawer gate finds nodes in child containers and reusable components", () => {
  expect(
    prototypeDrawerFields({
      root: { type: "drawer", child: drawer },
      components: { Drawer: { root: drawer } },
    }),
  ).toEqual(["root", "root.child", "components.Drawer.root"]);
  expect(prototypeDrawerFields(null)).toEqual([]);
  expect(prototypeGateCapabilities(spec(drawer))).toEqual(["prototype_drawer_v1"]);
});

test("drawer refusal reports platform, capability, path and multiplicity", () => {
  expect(prototypeDrawerUnsupportedMessage(["root"], "android")).toContain("prototype_drawer_v1");
  expect(prototypeDrawerUnsupportedMessage(["root"], "android")).toContain(
    "Update the connected CtrlProxy",
  );
  expect(prototypeDrawerUnsupportedMessage(["root", "root.child"], "ios")).toContain(
    "root (and 1 more)",
  );
  expect(prototypeDrawerUnsupportedMessage(["root"], "ios")).toContain("launchApp prototype: true");
});

test("drawer child participates in validation and mode-pair scrim gating", () => {
  const result = validatePrototypeSpec(
    spec({ ...drawer, scrim: { light: "scrim", dark: "#000000" }, dismissOnSwipe: false }),
  );
  expect(result.success).toBe(true);
  expect(
    prototypeGateCapabilities(spec({ ...drawer, scrim: { light: "scrim", dark: "#000000" } })),
  ).toContain("prototype_theme_modes_v1");
  expect(validatePrototypeSpec(spec({ ...drawer, child: { type: "noSuchNode" } }))).toMatchObject({
    success: false,
    error: { path: "root.child.type" },
  });
});
