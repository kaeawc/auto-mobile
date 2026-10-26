import { expect, test } from "bun:test";
import { isAndroidHintText } from "../../../src/features/action/androidHintText";

test.each([
  { className: "android.widget.EditText", hint: "Search", text: "Search", expected: true },
  {
    className: "androidx.appcompat.widget.AppCompatEditText",
    hint: "Search",
    text: "Search",
    expected: true,
  },
  { className: "UITextField", hint: "Search", text: "Search", expected: false },
  { className: undefined, hint: "Search", text: "Search", expected: false },
  { className: "android.widget.EditText", hint: undefined, text: "Search", expected: false },
  { className: "android.widget.EditText", hint: "", text: "", expected: false },
  { className: "android.widget.EditText", hint: 42, text: 42, expected: false },
  { className: "android.widget.EditText", hint: "Search", text: "abc", expected: false },
  { className: "android.widget.EditText", hint: "Search", text: "Search ", expected: false },
])("Android hint matching: %j", ({ className, hint, text, expected }) => {
  expect(isAndroidHintText(className, hint, text)).toBe(expected);
});
