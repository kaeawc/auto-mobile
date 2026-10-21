import optionsFixture from "../../fixtures/prototype-spec/valid/text-field-options.json";
import { describe, expect, test } from "bun:test";
import {
  prototypeTextFieldOptionFields,
  prototypeTextFieldOptionsUnsupportedMessage,
} from "../../../src/features/prototype/prototypeTextFieldOptions";
import { expandPrototypeComponents } from "../../../src/features/prototype/prototypeComponents";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const field = { type: "textField", stateKey: "name" };
describe("text field options", () => {
  test("finds every new option including explicit defaults", () => {
    expect(prototypeTextFieldOptionFields(optionsFixture)).toEqual([
      "root.children[0].label",
      "root.children[0].variant",
      "root.children[0].supportingText",
      "root.children[0].keyboardType",
      "root.children[1].variant",
      "root.children[1].keyboardType",
      "root.children[1].maxLength",
      "root.children[2].keyboardType",
      "root.children[2].secure",
      "root.children[3].multiline",
      "root.children[3].minLines",
      "root.children[3].maxLines",
    ]);
  });
  test("walks child, children and repeat templates in authored tree order", () => {
    const spec = {
      root: {
        type: "column",
        children: [
          { ...field, label: "Name", variant: "outlined", secure: false },
          { type: "scroll", child: { ...field, maxLength: 10 } },
          {
            type: "column",
            repeat: { items: [{ name: "Ada" }], as: "item" },
            children: [{ ...field, multiline: true, minLines: 1, maxLines: 2 }],
          },
        ],
      },
    };
    const before = JSON.stringify(spec);
    expect(prototypeTextFieldOptionFields(spec)).toEqual([
      "root.children[0].label",
      "root.children[0].variant",
      "root.children[0].secure",
      "root.children[1].child.maxLength",
      "root.children[2].children[0].multiline",
      "root.children[2].children[0].minLines",
      "root.children[2].children[0].maxLines",
    ]);
    expect(JSON.stringify(spec)).toBe(before);
  });
  test("component roots are scanned after the same host expansion as data-model fields", () => {
    const expanded = expandPrototypeComponents({
      components: { input: { root: { ...field, label: "Name" } } },
      root: { type: "use", component: "input" },
    });
    expect(expanded.success).toBe(true);
    if (!expanded.success) {
      throw new Error(expanded.error.message);
    }
    expect(prototypeTextFieldOptionFields(expanded.spec)).toEqual(["root.label"]);
  });
  test("plain fields, unrelated labels and malformed roots need no capability", () => {
    for (const spec of [
      null,
      {},
      { root: field },
      { root: { ...field, placeholder: "Name", testTag: "name" } },
      { root: { type: "button", label: "Go", variant: "filled" } },
    ]) {
      expect(prototypeTextFieldOptionFields(spec)).toEqual([]);
    }
  });
  test.each(["android", "ios"] as const)(
    "%s refusal names capability, path and remedy",
    (platform) => {
      const message = prototypeTextFieldOptionsUnsupportedMessage(
        ["root.label", "root.variant"],
        platform,
      );
      expect(message).toContain("prototype_text_field_options_v1");
      expect(message).toContain("root.label (and 1 more)");
      expect(message).toContain("Nothing was shown.");
      expect(message).toContain("drop the textField options");
      expect(message).toContain(
        platform === "ios" ? "launchApp prototype: true" : "Update the connected CtrlProxy",
      );
      expect(prototypeTextFieldOptionsUnsupportedMessage(["root.label"], platform)).not.toContain(
        "more",
      );
    },
  );
  test.each(["text", "number", "decimal", "email", "phone", "url", "password"])(
    "accepts %s keyboard",
    (keyboardType) => {
      expect(
        validatePrototypeSpec({
          id: "fields",
          window: { placement: { type: "fullscreen" } },
          state: { name: "Ada" },
          root: { ...field, keyboardType },
        }).success,
      ).toBe(true);
    },
  );
  test("minLines has precedence and maxLength counts UTF-16 like existing string checks", () => {
    const spec = (options: object) => ({
      id: "fields",
      window: { placement: { type: "fullscreen" } },
      state: { name: "😀" },
      root: { ...field, ...options },
    });
    expect(validatePrototypeSpec(spec({ maxLines: 2, minLines: 1 }))).toMatchObject({
      success: false,
      error: { path: "root.minLines", message: "Requires multiline: true" },
    });
    expect(validatePrototypeSpec(spec({ maxLength: 1 }))).toMatchObject({
      success: false,
      error: { path: "root.stateKey", message: "Text field value exceeds maxLength" },
    });
    expect(validatePrototypeSpec(spec({ maxLength: 2 })).success).toBe(true);
  });
});
