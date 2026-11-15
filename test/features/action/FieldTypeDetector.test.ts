import { describe, expect, test } from "bun:test";
import { FieldTypeDetector } from "../../../src/features/action/FieldTypeDetector";
import { Element } from "../../../src/models";

describe("FieldTypeDetector", () => {
  const detector = new FieldTypeDetector();

  const createElement = (overrides: Partial<Element> = {}): Element => ({
    bounds: { left: 0, top: 0, right: 100, bottom: 50 },
    ...overrides,
  });

  describe("detect", () => {
    describe("checkable text chip given a value (#18350)", () => {
      // Material time picker minute chip in text-input mode before focus.
      const minuteChip = (overrides: Partial<Element> = {}): Element =>
        createElement({
          class: "com.google.android.material.chip.Chip",
          text: "00",
          "content-desc": "0 minutes",
          checkable: "true",
          checked: "false",
          clickable: "true",
          focusable: "true",
          ...overrides,
        });

      test("classifies a focusable checkable chip as text when given a string value", () => {
        expect(detector.detect(minuteChip(), { value: "45" })).toBe("text");
      });

      test("classifies a checkable node exposing set_text as text when given a value", () => {
        const chip = minuteChip({ focusable: "false", actions: ["click", "set_text"] });
        expect(detector.detect(chip, { value: "45" })).toBe("text");
      });

      test("keeps the chip a checkbox without a value or with selected", () => {
        expect(detector.detect(minuteChip())).toBe("checkbox");
        expect(detector.detect(minuteChip(), { selected: true })).toBe("checkbox");
        expect(detector.detect(minuteChip(), { value: "45", selected: true })).toBe("checkbox");
      });

      test("keeps a non-focusable, non-editable checkable node a checkbox", () => {
        expect(detector.detect(minuteChip({ focusable: "false" }), { value: "45" })).toBe(
          "checkbox",
        );
      });

      test("keeps native CheckBox, RadioButton and Switch classes as toggles/checkboxes", () => {
        const intent = { value: "on" };
        expect(detector.detect(minuteChip({ class: "android.widget.CheckBox" }), intent)).toBe(
          "checkbox",
        );
        expect(
          detector.detect(
            minuteChip({ class: "com.google.android.material.radiobutton.MaterialRadioButton" }),
            intent,
          ),
        ).toBe("checkbox");
        expect(detector.detect(minuteChip({ class: "android.widget.Switch" }), intent)).toBe(
          "toggle",
        );
      });
    });

    describe("text field detection", () => {
      test("detects Android EditText as text", () => {
        const element = createElement({
          class: "android.widget.EditText",
          focusable: true,
          clickable: true,
        });
        expect(detector.detect(element)).toBe("text");
      });

      test("detects Android TextInputEditText as text", () => {
        const element = createElement({
          class: "com.google.android.material.textfield.TextInputEditText",
          focusable: true,
          clickable: true,
        });
        expect(detector.detect(element)).toBe("text");
      });

      test("detects iOS UITextField as text", () => {
        const element = createElement({
          class: "UITextField",
          focusable: true,
          clickable: true,
        });
        expect(detector.detect(element)).toBe("text");
      });

      test("detects iOS UITextView as text", () => {
        const element = createElement({
          class: "UITextView",
          focusable: true,
          clickable: true,
        });
        expect(detector.detect(element)).toBe("text");
      });

      test("detects iOS UISecureTextField as text", () => {
        // UITextField and UISecureTextField share identical setUIState
        // behaviour (tap + clear + type). The substring check would not
        // match "uisecuretextfield" against "uitextfield" (the `ui` and
        // `textfield` tokens are non-contiguous), so UISecureTextField
        // must be listed explicitly in IOS_PATTERNS.text.
        const element = createElement({
          class: "UISecureTextField",
          password: "true",
          focusable: true,
          clickable: true,
        });
        expect(detector.detect(element)).toBe("text");
      });

      test("detects iOS UISecureTextField as password field", () => {
        const element = createElement({
          class: "UISecureTextField",
          password: "true",
        });
        expect(detector.isPasswordField(element)).toBe(true);
      });

      test("shouldSkipVerification true for UISecureTextField text-type", () => {
        // Secure text fields report a masked value (e.g., "••••") that
        // cannot be compared to the target string. The password-field
        // branch in SetUIState.applyFieldValue relies on this skip so
        // the setUIState op doesn't falsely fail verification.
        const element = createElement({
          class: "UISecureTextField",
          password: "true",
        });
        // Without a concrete `value` attribute, iOS text verification
        // is unreliable — detector should skip.
        expect(detector.shouldSkipVerification(element, "text")).toBe(true);
      });

      test("detects focusable + clickable as text fallback", () => {
        const element = createElement({
          class: "com.custom.TextInput",
          focusable: true,
          clickable: true,
        });
        expect(detector.detect(element)).toBe("text");
      });
    });

    describe("checkbox detection", () => {
      test("detects Android CheckBox as checkbox", () => {
        const element = createElement({
          class: "android.widget.CheckBox",
          checkable: true,
        });
        expect(detector.detect(element)).toBe("checkbox");
      });

      test("detects AppCompat CheckBox as checkbox", () => {
        const element = createElement({
          class: "androidx.appcompat.widget.AppCompatCheckBox",
          checkable: true,
        });
        expect(detector.detect(element)).toBe("checkbox");
      });

      test("detects RadioButton as checkbox", () => {
        const element = createElement({
          class: "android.widget.RadioButton",
          checkable: true,
        });
        expect(detector.detect(element)).toBe("checkbox");
      });

      test("detects checkable without specific class as checkbox", () => {
        const element = createElement({
          class: "com.custom.CheckableView",
          checkable: true,
        });
        expect(detector.detect(element)).toBe("checkbox");
      });

      test("detects checkable=true as string", () => {
        const element = createElement({ class: "com.custom.View", checkable: "true" });
        expect(detector.detect(element)).toBe("checkbox");
      });
    });

    describe("toggle detection", () => {
      test("detects Android Switch as toggle", () => {
        const element = createElement({
          class: "android.widget.Switch",
          checkable: true,
        });
        expect(detector.detect(element)).toBe("toggle");
      });

      test("detects SwitchCompat as toggle", () => {
        const element = createElement({
          class: "androidx.appcompat.widget.SwitchCompat",
          checkable: true,
        });
        expect(detector.detect(element)).toBe("toggle");
      });

      test("detects SwitchMaterial as toggle", () => {
        const element = createElement({
          class: "com.google.android.material.switchmaterial.SwitchMaterial",
          checkable: true,
        });
        expect(detector.detect(element)).toBe("toggle");
      });

      test("detects iOS UISwitch as toggle", () => {
        const element = createElement({
          class: "UISwitch",
          checkable: true,
        });
        expect(detector.detect(element)).toBe("toggle");
      });

      test("detects ToggleButton as toggle", () => {
        const element = createElement({
          class: "android.widget.ToggleButton",
          checkable: true,
        });
        expect(detector.detect(element)).toBe("toggle");
      });
    });

    describe("dropdown detection", () => {
      test("detects Android Spinner as dropdown", () => {
        const element = createElement({
          class: "android.widget.Spinner",
        });
        expect(detector.detect(element)).toBe("dropdown");
      });

      test("detects AppCompat Spinner as dropdown", () => {
        const element = createElement({
          class: "androidx.appcompat.widget.AppCompatSpinner",
        });
        expect(detector.detect(element)).toBe("dropdown");
      });

      test("detects iOS UIPickerView as dropdown", () => {
        const element = createElement({
          class: "UIPickerView",
        });
        expect(detector.detect(element)).toBe("dropdown");
      });

      test("detects iOS UIDatePicker as dropdown", () => {
        const element = createElement({
          class: "UIDatePicker",
        });
        expect(detector.detect(element)).toBe("dropdown");
      });
    });

    describe("unknown detection", () => {
      test("returns unknown for non-interactive element", () => {
        const element = createElement({
          class: "android.widget.TextView",
        });
        expect(detector.detect(element)).toBe("unknown");
      });

      test("returns unknown for clickable-only element", () => {
        const element = createElement({
          class: "android.widget.Button",
          clickable: true,
        });
        expect(detector.detect(element)).toBe("unknown");
      });
    });
  });

  describe("isPasswordField", () => {
    test("returns true for password=true boolean", () => {
      const element = createElement({ password: true });
      expect(detector.isPasswordField(element)).toBe(true);
    });

    test("returns true for password='true' string", () => {
      const element = createElement({ password: "true" });
      expect(detector.isPasswordField(element)).toBe(true);
    });

    test("returns false for password=false", () => {
      const element = createElement({ password: false });
      expect(detector.isPasswordField(element)).toBe(false);
    });

    test("returns false for password='false' string", () => {
      const element = createElement({ password: "false" });
      expect(detector.isPasswordField(element)).toBe(false);
    });

    test("returns false for undefined password", () => {
      const element = createElement({});
      expect(detector.isPasswordField(element)).toBe(false);
    });
  });

  describe("isChecked", () => {
    test("returns true for checked=true boolean", () => {
      const element = createElement({ checked: true });
      expect(detector.isChecked(element)).toBe(true);
    });

    test("returns true for checked='true' string", () => {
      const element = createElement({ checked: "true" });
      expect(detector.isChecked(element)).toBe(true);
    });

    test("returns false for checked=false", () => {
      const element = createElement({ checked: false });
      expect(detector.isChecked(element)).toBe(false);
    });

    test("returns false for undefined checked", () => {
      const element = createElement({});
      expect(detector.isChecked(element)).toBe(false);
    });
  });

  describe("getTextValue", () => {
    test("returns text when present", () => {
      const element = createElement({ text: "Hello World" });
      expect(detector.getTextValue(element)).toBe("Hello World");
    });

    test("returns empty string when text is undefined", () => {
      const element = createElement({});
      expect(detector.getTextValue(element)).toBe("");
    });

    test("returns empty string when text is not a string", () => {
      expect(detector.getTextValue({ text: 123 })).toBe("");
    });

    test("prefers value attribute over text for iOS elements", () => {
      const element = createElement({
        class: "UITextField",
        text: "Email Address", // This is the label
        value: "user@example.com", // This is the actual input value
      });
      expect(detector.getTextValue(element)).toBe("user@example.com");
    });

    test("falls back to text when value is not present", () => {
      const element = createElement({
        class: "UITextField",
        text: "Email Address",
      });
      expect(detector.getTextValue(element)).toBe("Email Address");
    });
  });

  describe("isIOSElement", () => {
    test("returns true for UITextField", () => {
      const element = createElement({ class: "UITextField" });
      expect(detector.isIOSElement(element)).toBe(true);
    });

    test("returns true for UITextView", () => {
      const element = createElement({ class: "UITextView" });
      expect(detector.isIOSElement(element)).toBe(true);
    });

    test("returns true for UISwitch", () => {
      const element = createElement({ class: "UISwitch" });
      expect(detector.isIOSElement(element)).toBe(true);
    });

    test("returns true for UIPickerView", () => {
      const element = createElement({ class: "UIPickerView" });
      expect(detector.isIOSElement(element)).toBe(true);
    });

    test("returns false for Android EditText", () => {
      const element = createElement({ class: "android.widget.EditText" });
      expect(detector.isIOSElement(element)).toBe(false);
    });
  });

  describe("shouldSkipVerification", () => {
    test("returns true for iOS text field without value attribute", () => {
      const element = createElement({
        class: "UITextField",
        text: "Label only",
      });
      expect(detector.shouldSkipVerification(element, "text")).toBe(true);
    });

    test("returns false for iOS text field with value attribute", () => {
      const element = createElement({
        class: "UITextField",
        text: "Label",
        value: "actual value",
      });
      expect(detector.shouldSkipVerification(element, "text")).toBe(false);
    });

    test("returns true for iOS dropdown without value attribute", () => {
      const element = createElement({
        class: "UIPickerView",
        text: "Select option",
      });
      expect(detector.shouldSkipVerification(element, "dropdown")).toBe(true);
    });

    test("returns false for iOS checkbox/toggle (verification works)", () => {
      const element = createElement({
        class: "UISwitch",
        checkable: true,
      });
      expect(detector.shouldSkipVerification(element, "toggle")).toBe(false);
    });

    test("returns false for Android text field", () => {
      const element = createElement({
        class: "android.widget.EditText",
        text: "some value",
      });
      expect(detector.shouldSkipVerification(element, "text")).toBe(false);
    });
  });
});
