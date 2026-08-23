import { describe, expect, test } from "bun:test";
import {
  createStructuredToolResponse,
  getStructuredField,
  getStructuredPayload,
  StructuredToolResponse,
} from "../../src/utils/toolUtils";

/**
 * Typed seam for the envelope-vs-`structuredContent` dead-read bug class (issues
 * #2907 / #2932). `createStructuredToolResponse` hoists ONLY `success`/`error`
 * to the envelope top level; every other payload field lives under
 * `structuredContent`, so a raw `response.found` read silently yields
 * `undefined`.
 *
 * `getStructuredField` is now fully typed against a concrete payload: the `key`
 * is constrained to `keyof TPayload` and the return type is `TPayload[K]`. That
 * makes BOTH the envelope-top-level read AND a key typo / wrong `<T>` a **compile
 * error** (issue #2932) — the compile-time half is asserted by the typecheck
 * gate over the migrated src read sites (toolRegistry, DefaultUIStateSetup); the
 * runtime behavior below asserts the accessor is otherwise unchanged.
 */

/** Minimal concrete payload standing in for a real tool payload. */
interface SamplePayload {
  success: boolean;
  found?: boolean;
  viewHierarchy?: { hierarchy: { node: object } };
  awaitTimeout?: boolean;
}

// A loose view of the accessor, used ONLY to exercise the runtime own-key guard
// with keys the type system now (correctly) forbids passing directly.
const looseField = getStructuredField as unknown as (response: unknown, key: string) => unknown;

describe("getStructuredField (typed)", () => {
  test("returns a payload field that lives under structuredContent", () => {
    const response = createStructuredToolResponse<SamplePayload>({ success: true, found: true });
    const found: boolean | undefined = getStructuredField(response, "found");
    expect(found).toBe(true);
  });

  test("returns a nested object field by reference", () => {
    const hierarchy = { hierarchy: { node: {} } };
    const response = createStructuredToolResponse<SamplePayload>({
      success: true,
      viewHierarchy: hierarchy,
    });
    expect(getStructuredField(response, "viewHierarchy")).toBe(hierarchy);
  });

  test("returns undefined for a field absent from the payload", () => {
    const response = createStructuredToolResponse<SamplePayload>({ success: true });
    expect(getStructuredField(response, "found")).toBeUndefined();
  });

  test("ignores a field that exists only at the envelope top level, not in structuredContent", () => {
    // Hand-built envelope where `found` sits at the top level but NOT in the
    // payload — the accessor must read only `structuredContent` and not leak it.
    const envelope: StructuredToolResponse<SamplePayload> = {
      content: [],
      structuredContent: { success: true },
    };
    (envelope as Record<string, unknown>).found = true;
    expect(getStructuredField(envelope, "found")).toBeUndefined();
  });

  test("returns undefined for null / undefined responses", () => {
    expect(getStructuredField<SamplePayload, "found">(null, "found")).toBeUndefined();
    expect(getStructuredField<SamplePayload, "found">(undefined, "found")).toBeUndefined();
  });

  test("returns undefined when structuredContent is missing or not an object", () => {
    expect(looseField({ content: [] }, "found")).toBeUndefined();
    expect(looseField({ structuredContent: "not-an-object" }, "found")).toBeUndefined();
    expect(looseField({ structuredContent: null }, "found")).toBeUndefined();
  });

  test("reading the same field off the envelope top level is undefined (the foot-gun)", () => {
    const response = createStructuredToolResponse<SamplePayload>({ success: true, found: true });
    // Raw top-level read — the mistake this accessor exists to prevent. At the
    // migrated src read sites this line is now a COMPILE error; here we cast to
    // reproduce the historical runtime foot-gun.
    expect((response as Record<string, unknown>).found).toBeUndefined();
    // Accessor gets the real value.
    expect(getStructuredField(response, "found")).toBe(true);
  });

  test("does not resolve inherited (non-own) keys like prototype methods", () => {
    const response = createStructuredToolResponse<SamplePayload>({ success: true });
    // `toString`/`constructor`/`__proto__` exist on Object.prototype but are not
    // payload fields. The keyof constraint now makes passing them a compile error,
    // so the own-key runtime guard is defense-in-depth — exercised via the loose
    // view to prove it still holds.
    expect(looseField(response, "toString")).toBeUndefined();
    expect(looseField(response, "constructor")).toBeUndefined();
    expect(looseField(response, "__proto__")).toBeUndefined();
  });

  test("resolves an own key whose value is falsy (found: false)", () => {
    const response = createStructuredToolResponse<SamplePayload>({ success: true, found: false });
    expect(getStructuredField(response, "found")).toBe(false);
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
    const response = createStructuredToolResponse(
      "plain-string" as unknown as { success?: boolean },
    );
    expect(response.structuredContent).toBe("plain-string");
    expect("success" in response).toBe(false);
  });
});
