import { expect, test } from "bun:test";
import {
  prototypeRequiredCapabilities,
  PROTOTYPE_SPEC_CAPABILITY_GATES,
} from "../../../src/features/prototype/prototypeCapabilityGates";
import { prototypeThemeModesUnsupportedMessage } from "../../../src/features/prototype/prototypeThemeModes";
import { prototypeDataModelUnsupportedMessage } from "../../../src/features/prototype/prototypeData";
import { prototypeTextFieldOptionsUnsupportedMessage } from "../../../src/features/prototype/prototypeTextFieldOptions";
import { prototypeFlowGridUnsupportedMessage } from "../../../src/features/prototype/prototypeFlowGrid";
import { prototypePagerOptionsUnsupportedMessage } from "../../../src/features/prototype/prototypePagerOptions";

test("plain and non-spec inputs require no capability", () => {
  for (const spec of [undefined, null, 3, {}, { root: { type: "text", text: "Hello" } }]) {
    expect(prototypeRequiredCapabilities(spec)).toEqual([]);
  }
});
test("required gates report fields and original messages", () => {
  const spec = {
    data: { x: 1 },
    root: {
      type: "text",
      text: "{data:/x}",
      style: { background: { light: "#FFFFFF", dark: "#000000" } },
      children: [
        { type: "textField", label: "Name" },
        { type: "grid", columns: 2 },
      ],
    },
  };
  const required = prototypeRequiredCapabilities(spec);
  expect(required.map((gate) => gate.capability)).toEqual([
    "prototype_theme_modes_v1",
    "prototype_data_model_v1",
    "prototype_text_field_options_v1",
    "prototype_flow_grid_v1",
  ]);
  expect(required.map((gate) => gate.fields)).toEqual([
    ["root.style.background"],
    ["data", "root.text"],
    ["root.children[0].label"],
    ["root.children[1]"],
  ]);
  expect(required.map((gate) => gate.unsupportedMessage)).toEqual([
    prototypeThemeModesUnsupportedMessage,
    prototypeDataModelUnsupportedMessage,
    prototypeTextFieldOptionsUnsupportedMessage,
    prototypeFlowGridUnsupportedMessage,
  ]);
  expect(
    PROTOTYPE_SPEC_CAPABILITY_GATES.map((gate) => gate.fields(spec)).filter((f) => f.length > 0),
  ).toEqual(
    required.map((gate) => gate.fields),
  );
  expect(required.find((gate) => gate.capability === "prototype_theme_modes_v1")).toMatchObject({
    fields: ["root.style.background"],
    unsupportedMessage: prototypeThemeModesUnsupportedMessage,
  });
  expect(required.find((gate) => gate.capability === "prototype_data_model_v1")).toMatchObject({
    fields: ["data", "root.text"],
    unsupportedMessage: prototypeDataModelUnsupportedMessage,
  });
  const pagerSpec = {
    root: { type: "pager", axis: "vertical", pageSize: 0.8 },
  };
  const pagerRequired = prototypeRequiredCapabilities(pagerSpec);
  expect(pagerRequired).toHaveLength(1);
  expect(pagerRequired[0]).toMatchObject({
    capability: "prototype_pager_options_v1",
    fields: ["root.axis", "root.pageSize"],
    unsupportedMessage: prototypePagerOptionsUnsupportedMessage,
  });
  expect(
    PROTOTYPE_SPEC_CAPABILITY_GATES.find(
      (gate) => gate.capability === "prototype_pager_options_v1",
    )?.fields(pagerSpec),
  ).toEqual(["root.axis", "root.pageSize"]);
});
test("only used gates are returned without mutating the spec", () => {
  const spec = { root: { type: "text", text: "{data:/x}" } };
  const before = structuredClone(spec);
  expect(prototypeRequiredCapabilities(spec).map((gate) => gate.capability)).toEqual([
    "prototype_data_model_v1",
  ]);
  expect(spec).toEqual(before);
});
