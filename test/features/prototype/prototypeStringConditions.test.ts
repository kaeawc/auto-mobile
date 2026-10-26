import { bindNodeFields } from "../../../src/features/prototype/prototypeTemplate";
import { expect, test } from "bun:test";
import fixtures from "../../fixtures/prototype-spec/conditions/string-conditions.json";
import { conditionSchema } from "../../../src/features/prototype/prototypePresentationSchemas";
import {
  prototypeStringConditionsFields,
  prototypeStringConditionsUnsupportedMessage,
} from "../../../src/features/prototype/prototypeStringConditions";
import { requiredPrototypeCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";

function holds(condition: Record<string, unknown>, state: Record<string, unknown>): boolean {
  if (Array.isArray(condition.all)) {
    return condition.all.every((c) => holds(c, state));
  }
  if (Array.isArray(condition.any)) {
    return condition.any.some((c) => holds(c, state));
  }
  if (condition.not && typeof condition.not === "object") {
    return !holds(Object.fromEntries(Object.entries(condition.not)), state);
  }
  const value = state[String(condition.key)];
  if (typeof value !== "string") {
    return false;
  }
  if (typeof condition.contains === "string") {
    return value.includes(condition.contains);
  }
  if (typeof condition.startsWith === "string") {
    return value.startsWith(condition.startsWith);
  }
  if (typeof condition.lengthGt === "number") {
    return value.length > condition.lengthGt;
  }
  if (typeof condition.lengthLt === "number") {
    return value.length < condition.lengthLt;
  }
  return false;
}
for (const fixture of fixtures) {
  test(fixture.name, () => {
    expect(conditionSchema.safeParse(fixture.condition).success).toBe(true);
    expect(holds(fixture.condition, fixture.state)).toBe(fixture.expected);
  });
}
test("gate visits condition slots and textField errors only", () => {
  const spec = {
    state: { contains: "x" },
    data: { contains: "x" },
    root: {
      type: "column",
      style: { contains: "x" },
      children: [
        {
          type: "textField",
          stateKey: "value",
          errorWhen: { not: { key: "value", contains: "x" } },
          errorText: "Error",
        },
        { type: "text", text: "x", visibleWhen: { key: "value", startsWith: "x" } },
      ],
    },
  };
  expect(prototypeStringConditionsFields(spec)).toEqual([
    "root.children[0].errorWhen",
    "root.children[0].errorWhen.not.contains",
    "root.children[0].errorText",
    "root.children[1].visibleWhen.startsWith",
  ]);
  expect(requiredPrototypeCapabilities(spec)).toContain("prototype_string_conditions_v1");
  expect(prototypeStringConditionsUnsupportedMessage(["root.errorWhen"], "ios")).toContain(
    "prototype_string_conditions_v1",
  );
});

test("repeat binds string operands and error conditions like equality operands", () => {
  const node = {
    type: "textField",
    stateKey: "value",
    errorWhen: {
      all: [
        { key: "value", contains: "{item.x}" },
        { key: "value", startsWith: "{index}" },
      ],
    },
    errorText: "Bad {index}",
  };
  expect(
    bindNodeFields(node, "root", {
      binding: { alias: "item", index: true },
      values: { x: "" },
      index: 0,
    }),
  ).toEqual({
    type: "textField",
    stateKey: "value",
    errorWhen: {
      all: [
        { key: "value", contains: "" },
        { key: "value", startsWith: "0" },
      ],
    },
    errorText: "Bad 0",
  });
});

test("empty substituted operands hold and literal UTF-16 limits are enforced", () => {
  expect(holds({ key: "value", contains: "" }, { value: "hello" })).toBe(true);
  expect(holds({ key: "value", startsWith: "" }, { value: "" })).toBe(true);
  expect(conditionSchema.safeParse({ key: "value", contains: "😀".repeat(128) }).success).toBe(
    true,
  );
  expect(conditionSchema.safeParse({ key: "value", startsWith: "😀".repeat(129) }).success).toBe(
    false,
  );
});

test("errorWhen data conditions require data support without adding checks bookkeeping", () => {
  expect(
    requiredPrototypeCapabilities({
      root: {
        type: "textField",
        stateKey: "value",
        errorWhen: { data: "/serverError", equals: true },
      },
    }),
  ).toEqual(["prototype_data_model_v1", "prototype_string_conditions_v1"]);
});
