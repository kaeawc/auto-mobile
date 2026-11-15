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

  test("a value of only formatting characters must match exactly", () => {
    expect(matchTextValue("--", "-")).toBe("mismatch");
    expect(matchTextValue("", " ")).toBe("mismatch");
  });
});
