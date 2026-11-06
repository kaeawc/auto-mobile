import { describe, expect, test } from "bun:test";
import {
  prototypeSensitiveSinkErrors,
  prototypeSensitiveWarnings,
} from "../../../src/features/prototype/prototypeStrictPolicy";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

/** A spec declaring sensitive location state beside a web view loading `url`. */
function specWith(url: string) {
  return {
    id: "sensitive-webview",
    window: { placement: { type: "fullscreen" } },
    requires: { platform: ["location", "webview"] },
    root: {
      type: "column",
      children: [
        { type: "text", text: "Location: {platform:/location/current}" },
        { type: "webView", url, allowedOrigins: ["https://example.com"] },
      ],
    },
  };
}

describe("web view urls are sensitive request sinks", () => {
  test("a url interpolating a sensitive platform value is flagged like a request url", () => {
    const spec = specWith("https://example.com/map?at={platform:/location/current}");
    const error = {
      path: "root.children[1].url",
      message: "Sensitive value cannot be bound into a request",
    };
    expect(validatePrototypeSpec(spec).success).toBe(true);
    expect(prototypeSensitiveSinkErrors(spec)).toEqual([error]);
    expect(prototypeSensitiveWarnings(spec)).toEqual([
      `${error.path}: ${error.message}; this is a warning only and does not block the show.`,
    ]);
    expect(validatePrototypeSpec(spec, { library: true })).toEqual({ success: false, error });
  });

  test("a url without a sensitive value is not flagged", () => {
    const spec = specWith("https://example.com/map?zoom=12");
    expect(validatePrototypeSpec(spec).success).toBe(true);
    expect(prototypeSensitiveSinkErrors(spec)).toEqual([]);
    expect(prototypeSensitiveWarnings(spec)).toEqual([]);
  });

  test("a url interpolating non-sensitive platform state is not flagged", () => {
    const spec = specWith("https://example.com/map?os={platform:/device/os}");
    expect(prototypeSensitiveSinkErrors(spec)).toEqual([]);
  });
});
