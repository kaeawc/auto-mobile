import { describe, expect, test } from "bun:test";
import { prototypeLinksArgumentsError } from "../../../src/features/prototype/prototypeLinks";

const literal = (url: string, mode?: string) => ({
  url: { value: url },
  ...(mode === undefined ? {} : { mode: { value: mode } }),
});

describe("prototypeLinksArgumentsError", () => {
  test("refuses inApp for every non-web scheme at the mode value", () => {
    for (const url of [
      "tel:+15551234567",
      "mailto:ada@example.test",
      "sms:+15551234567",
      "geo:37.78,-122.41",
      "maps://?q=coffee",
    ]) {
      expect(prototypeLinksArgumentsError(literal(url, "inApp"), "x.args")).toEqual({
        path: "x.args.mode.value",
        message: "links.open mode inApp requires an http or https url",
      });
    }
  });

  test("accepts inApp for http and https, and any scheme in external, auto or default mode", () => {
    expect(prototypeLinksArgumentsError(literal("https://a.test", "inApp"), "a")).toBeUndefined();
    expect(
      prototypeLinksArgumentsError(literal("http://a.test/{id}", "inApp"), "a"),
    ).toBeUndefined();
    for (const mode of ["external", "auto", undefined]) {
      expect(prototypeLinksArgumentsError(literal("tel:+1555", mode), "a")).toBeUndefined();
    }
  });

  test("leaves bound url or mode to the runtime", () => {
    expect(
      prototypeLinksArgumentsError({ url: { state: "url" }, mode: { value: "inApp" } }, "a"),
    ).toBeUndefined();
    expect(
      prototypeLinksArgumentsError({ url: { value: "tel:+1555" }, mode: { data: "/mode" } }, "a"),
    ).toBeUndefined();
  });
});
