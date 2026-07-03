import { describe, expect, test } from "bun:test";
import {
  createStructuredToolResponse,
  getStructuredField,
} from "../../src/utils/toolUtils";

/**
 * Typed seam for the envelope-vs-`structuredContent` dead-read bug class (issue
 * #2907). `createStructuredToolResponse` hoists ONLY `success`/`error` to the
 * envelope top level; every other payload field lives under `structuredContent`.
 * A raw `response.found` read silently yields `undefined`. `getStructuredField`
 * is the single accessor every payload-field read must route through.
 */
describe("getStructuredField", () => {
  test("returns a payload field that lives under structuredContent", () => {
    const response = createStructuredToolResponse({ success: true, found: true });
    expect(getStructuredField<boolean>(response, "found")).toBe(true);
  });

  test("returns a nested object field by reference", () => {
    const hierarchy = { hierarchy: { node: {} } };
    const response = createStructuredToolResponse({ success: true, viewHierarchy: hierarchy });
    expect(getStructuredField(response, "viewHierarchy")).toBe(hierarchy);
  });

  test("returns undefined for a field absent from the payload", () => {
    const response = createStructuredToolResponse({ success: true });
    expect(getStructuredField(response, "found")).toBeUndefined();
  });

  test("returns undefined when the field only exists at the envelope top level", () => {
    // This is the whole point: `success`/`error` are hoisted, but reading them
    // as payload fields off `structuredContent` still works because the payload
    // also carries them. A field that the caller mistakenly expects at the top
    // level (never hoisted) must not leak through.
    const response = createStructuredToolResponse({ success: true, error: "boom" });
    // A hoisted-only field like a hypothetical top-level `found` is not present.
    expect(getStructuredField(response, "found")).toBeUndefined();
  });

  test("returns undefined for null / undefined responses", () => {
    expect(getStructuredField(null, "found")).toBeUndefined();
    expect(getStructuredField(undefined, "found")).toBeUndefined();
  });

  test("returns undefined when structuredContent is missing or not an object", () => {
    expect(getStructuredField({ content: [] }, "found")).toBeUndefined();
    expect(getStructuredField({ structuredContent: "not-an-object" }, "found")).toBeUndefined();
    expect(getStructuredField({ structuredContent: null }, "found")).toBeUndefined();
  });

  test("reading the same field off the envelope top level is undefined (the foot-gun)", () => {
    const response = createStructuredToolResponse({ success: true, found: true });
    // Raw top-level read — the mistake this accessor exists to prevent.
    expect((response as Record<string, unknown>).found).toBeUndefined();
    // Accessor gets the real value.
    expect(getStructuredField<boolean>(response, "found")).toBe(true);
  });
});

describe("createStructuredToolResponse typed envelope", () => {
  test("carries the payload under structuredContent", () => {
    const payload = { success: true, found: false, extra: 42 };
    const response = createStructuredToolResponse(payload);
    expect(response.structuredContent).toEqual(payload);
  });

  test("hoists only success and error to the top level", () => {
    const response = createStructuredToolResponse({ success: false, error: "nope", found: true });
    expect(response.success).toBe(false);
    expect(response.error).toBe("nope");
    // `found` is NOT hoisted — it lives only under structuredContent.
    expect((response as Record<string, unknown>).found).toBeUndefined();
  });

  test("omits success/error when the payload lacks them", () => {
    const response = createStructuredToolResponse({ ok: true });
    expect("success" in response).toBe(false);
    expect("error" in response).toBe(false);
  });

  test("serializes the payload into the text content part", () => {
    const response = createStructuredToolResponse({ success: true, found: true });
    expect(response.content[0].type).toBe("text");
    expect(JSON.parse(response.content[0].text)).toEqual({ success: true, found: true });
  });

  test("tolerates non-object payloads without hoisting", () => {
    const response = createStructuredToolResponse("plain-string" as unknown as { success?: boolean });
    expect(response.structuredContent).toBe("plain-string");
    expect("success" in response).toBe(false);
  });
});
