import { expect, test } from "bun:test";
import {
  prototypeRequiredCapabilities,
  PROTOTYPE_SPEC_CAPABILITY_GATES,
} from "../../../src/features/prototype/prototypeCapabilityGates";
import { prototypeThemeModesUnsupportedMessage } from "../../../src/features/prototype/prototypeThemeModes";
import {
  prototypeDataModelUnsupportedMessage,
  prototypeMenusUnsupportedMessage,
} from "../../../src/features/prototype/prototypeData";

test("plain and non-spec inputs require no capability", () => {
  for (const spec of [undefined, null, 3, {}, { root: { type: "text", text: "Hello" } }]) {
    expect(prototypeRequiredCapabilities(spec)).toEqual([]);
  }
});
test("required gates retain registry order, fields and original messages", () => {
  const spec = {
    data: { x: 1 },
    root: {
      type: "column",
      children: [
        {
          type: "text",
          text: "{data:/x}",
          style: { background: { light: "#FFFFFF", dark: "#000000" } },
        },
        { type: "menu", items: [] },
      ],
    },
  };
  const required = prototypeRequiredCapabilities(spec);
  expect(required.map((gate) => gate.capability)).toEqual([
    "prototype_theme_modes_v1",
    "prototype_data_model_v1",
    "prototype_menus_v1",
  ]);
  expect(required.map((gate) => gate.fields)).toEqual([
    ["root.children[0].style.background"],
    ["data", "root.children[0].text"],
    ["root.children[1]"],
  ]);
  expect(required.map((gate) => gate.unsupportedMessage)).toEqual([
    prototypeThemeModesUnsupportedMessage,
    prototypeDataModelUnsupportedMessage,
    prototypeMenusUnsupportedMessage,
  ]);
  expect(PROTOTYPE_SPEC_CAPABILITY_GATES.map((gate) => gate.fields(spec))).toEqual(
    required.map((gate) => gate.fields),
  );
});
test("only used gates are returned without mutating the spec", () => {
  const spec = { root: { type: "text", text: "{data:/x}" } };
  const before = structuredClone(spec);
  expect(prototypeRequiredCapabilities(spec).map((gate) => gate.capability)).toEqual([
    "prototype_data_model_v1",
  ]);
  expect(spec).toEqual(before);
});
