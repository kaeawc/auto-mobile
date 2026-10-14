import { expect, test } from "bun:test";
import {
  prototypeRequiredCapabilities,
  PROTOTYPE_SPEC_CAPABILITY_GATES,
} from "../../../src/features/prototype/prototypeCapabilityGates";
import { prototypeThemeModesUnsupportedMessage } from "../../../src/features/prototype/prototypeThemeModes";
import { prototypeDataModelUnsupportedMessage } from "../../../src/features/prototype/prototypeData";
import { prototypeRichTextUnsupportedMessage } from "../../../src/features/prototype/prototypeRichText";

test("plain and non-spec inputs require no capability", () => {
  for (const spec of [undefined, null, 3, {}, { root: { type: "text", text: "Hello" } }]) {
    expect(prototypeRequiredCapabilities(spec)).toEqual([]);
  }
});
test("required gates retain registry order, fields and original messages", () => {
  const spec = {
    data: { x: 1 },
    components: { rich: { root: { type: "text", spans: [{ text: "Hi" }] } } },
    root: {
      type: "text",
      text: "{data:/x}",
      style: { background: { light: "#FFFFFF", dark: "#000000" } },
    },
  };
  const required = prototypeRequiredCapabilities(spec);
  expect(required.map((gate) => gate.capability)).toEqual([
    "prototype_theme_modes_v1",
    "prototype_data_model_v1",
    "prototype_rich_text_v1",
  ]);
  expect(required.map((gate) => gate.fields)).toEqual([
    ["root.style.background"],
    ["data", "root.text"],
    ["components.rich.root.spans"],
  ]);
  expect(required.map((gate) => gate.unsupportedMessage)).toEqual([
    prototypeThemeModesUnsupportedMessage,
    prototypeDataModelUnsupportedMessage,
    prototypeRichTextUnsupportedMessage,
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
