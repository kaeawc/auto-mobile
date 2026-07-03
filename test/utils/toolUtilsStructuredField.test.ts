import { describe, expect, test } from "bun:test";
import {
  createStructuredToolResponse,
  getStructuredField,
  getStructuredPayload,
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

  test("ignores a field that exists only at the envelope top level, not in structuredContent", () => {
    // Hand-built envelope where `found` sits at the top level but NOT in the
    // payload — the accessor must read only `structuredContent` and not leak it.
    const envelope = { content: [], structuredContent: { success: true }, found: true };
    expect(getStructuredField<boolean>(envelope, "found")).toBeUndefined();
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

  test("does not resolve inherited (non-own) keys like prototype methods", () => {
    const response = createStructuredToolResponse({ success: true });
    // `toString`/`constructor` exist on Object.prototype but are not payload
    // fields — an own-key guard must keep them from leaking through.
    expect(getStructuredField(response, "toString")).toBeUndefined();
    expect(getStructuredField(response, "constructor")).toBeUndefined();
    expect(getStructuredField(response, "__proto__")).toBeUndefined();
  });

  test("resolves an own key whose value is falsy (found: false)", () => {
    const response = createStructuredToolResponse({ success: true, found: false });
    expect(getStructuredField<boolean>(response, "found")).toBe(false);
  });
});

describe("getStructuredPayload", () => {
  test("returns the whole payload object under structuredContent", () => {
    const payload = { success: true, found: true, awaitTimeout: false };
    const response = createStructuredToolResponse(payload);
    expect(getStructuredPayload(response)).toEqual(payload);
    expect(getStructuredPayload(response)).toBe(response.structuredContent);
  });

  test("returns undefined for null / undefined responses", () => {
    expect(getStructuredPayload(null)).toBeUndefined();
    expect(getStructuredPayload(undefined)).toBeUndefined();
  });

  test("returns undefined when structuredContent is missing or not an object", () => {
    expect(getStructuredPayload({ content: [] })).toBeUndefined();
    expect(getStructuredPayload({ structuredContent: "text" })).toBeUndefined();
    expect(getStructuredPayload({ structuredContent: null })).toBeUndefined();
  });

  test("does NOT fall back to parsing the serialized text part", () => {
    // A text-only envelope carries the payload as JSON in content[0].text, not
    // under structuredContent — getStructuredPayload deliberately ignores it.
    const textOnly = { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
    expect(getStructuredPayload(textOnly)).toBeUndefined();
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
