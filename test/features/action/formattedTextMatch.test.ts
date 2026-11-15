import { describe, expect, test } from "bun:test";
import { matchTextValue } from "../../../src/features/action/formattedTextMatch";

describe("matchTextValue", () => {
  test("identical values match exactly", () => {
    expect(matchTextValue("Priya", "Priya")).toBe("exact");
  });

  test("an app-formatted phone number matches after normalization", () => {
    expect(matchTextValue("4155550142", "(415) 555-0142")).toBe("normalized");
    expect(matchTextValue("+1 415-555-0142", "+14155550142")).toBe("normalized");
  });

  test("different digits or letters do not match", () => {
    expect(matchTextValue("4155550142", "(415) 555-0143")).toBe("mismatch");
    expect(matchTextValue("Shah", "shah")).toBe("mismatch");
    expect(matchTextValue("Fold Test", "Duo TesteFold Test")).toBe("mismatch");
  });

  test("phone formatting with dashes, spaces and parentheses matches", () => {
    expect(matchTextValue("415-555-0142", "(415) 555-0142")).toBe("normalized");
    expect(matchTextValue("(415) 555-0142", "4155550142")).toBe("normalized");
    expect(matchTextValue("4111 1111 1111 1111", "4111111111111111")).toBe("normalized");
  });

  test("thousands separators are ignored but decimal commas are not", () => {
    expect(matchTextValue("1000", "1,000")).toBe("normalized");
    expect(matchTextValue("1234567.89", "1,234,567.89")).toBe("normalized");
    expect(matchTextValue("15", "1,5")).toBe("mismatch");
  });

  test("sign, decimal point and currency symbol are significant", () => {
    expect(matchTextValue("-5", "5")).toBe("mismatch");
    expect(matchTextValue("5", "-5")).toBe("mismatch");
    expect(matchTextValue("1.5", "15")).toBe("mismatch");
    expect(matchTextValue("$5", "5")).toBe("mismatch");
    expect(matchTextValue("5", "€5")).toBe("mismatch");
    expect(matchTextValue("+5", "5")).toBe("mismatch");
    expect(matchTextValue("5-3", "53")).toBe("mismatch");
    expect(matchTextValue("(5)", "5")).toBe("mismatch");
    expect(matchTextValue("1.23", "123")).toBe("mismatch");
    expect(matchTextValue("-10", "10")).toBe("mismatch");
  });

  test("a sign on a long number is not phone formatting", () => {
    expect(matchTextValue("-1234567", "1234567")).toBe("mismatch");
    expect(matchTextValue("1234567", "-1234567")).toBe("mismatch");
    expect(matchTextValue("1234567-", "1234567")).toBe("mismatch");
  });

  test("a value of only formatting characters must match exactly", () => {
    expect(matchTextValue("--", "-")).toBe("mismatch");
    expect(matchTextValue("", " ")).toBe("mismatch");
  });
});
