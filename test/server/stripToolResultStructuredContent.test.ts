import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  responseCarriesStructuredContent,
  stripToolResultStructuredContent,
  structuredContentOmissionReason,
} from "../../src/server/stripToolResultStructuredContent";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { serverConfig } from "../../src/utils/ServerConfig";

/**
 * Wire-boundary strip for the duplicated `structuredContent` tree.
 * `content[0].text` and `structuredContent` are byte-identical duplicates, so
 * dropping the latter halves the wire payload with no data loss. The strip is a
 * pure mechanism: the omission decision is resolved by
 * `structuredContentOmissionReason` (tested separately) and passed in as `reason`
 * (issue #2962) — any reason drops the field, `null` retains it.
 *
 *   reason         | drops structuredContent?
 *   ---------------|-------------------------
 *   "no-schema"    | YES (#2759 no-schema unconditional)
 *   "flag"         | YES (#2899 flag on a schema tool)
 *   null           | NO  (schema tool, flag off — spec-conforming)
 */
describe("stripToolResultStructuredContent", () => {
  test("EC-A: drops structuredContent for a 'flag' reason (schema tool, gate on), keeps content text", () => {
    const payload = { success: true, message: "done", nested: { a: 1 } };
    const response = stripToolResultStructuredContent(
      createStructuredToolResponse(payload),
      "flag",
    );

    expect("structuredContent" in response).toBe(false);
    expect(response.content[0].type).toBe("text");
    // Full payload is still recoverable from the retained text — no data loss.
    expect(JSON.parse(response.content[0].text)).toEqual(payload);
  });

  test("EC-B: preserves structuredContent for a null reason (schema tool, gate off)", () => {
    const response = stripToolResultStructuredContent(
      createStructuredToolResponse({ success: true }),
      null,
    );
    expect(response.structuredContent).toEqual({ success: true });
  });

  test("EC-2759: drops structuredContent for a 'no-schema' reason, keeping the text block", () => {
    const payload = { success: true, viewHierarchy: { node: [] } };
    const response = stripToolResultStructuredContent(
      createStructuredToolResponse(payload),
      "no-schema",
    );
    expect("structuredContent" in response).toBe(false);
    // Text block is preserved — the model-facing surface is intact.
    expect(JSON.parse(response.content[0].text)).toEqual(payload);
  });

  test("EC-D: strips regardless of payload shape (covers plain-registered tools)", () => {
    // e.g. exportPlan/recordSteps: declare an outputSchema, bypass finalizeToolResponse.
    const response = stripToolResultStructuredContent(
      createStructuredToolResponse({ success: true, plan: "steps:\n  - tapOn: {}" }),
      "flag",
    );
    expect("structuredContent" in response).toBe(false);
    expect(JSON.parse(response.content[0].text).plan).toBe("steps:\n  - tapOn: {}");
  });

  test("EC-E: response without structuredContent is an unchanged no-op even with a reason", () => {
    const imageResponse: any = { content: [{ type: "image", data: "b64", mimeType: "image/png" }] };
    const result = stripToolResultStructuredContent(imageResponse, "no-schema");
    expect(result).toBe(imageResponse);
    expect("structuredContent" in result).toBe(false);
  });

  test("null / primitive responses pass through untouched", () => {
    expect(stripToolResultStructuredContent(null, "no-schema")).toBeNull();
    expect(stripToolResultStructuredContent(undefined, "no-schema")).toBeUndefined();
    expect(stripToolResultStructuredContent("plain", "no-schema")).toBe("plain");
    expect(stripToolResultStructuredContent(42, "no-schema")).toBe(42);
  });
});

/**
 * `responseCarriesStructuredContent` gates BOTH the strip's delete and the
 * `index.ts` debug trace, so the trace only fires when a field is actually
 * dropped (never merely because the policy would). It must recognize an envelope
 * carrying the field and reject everything else.
 */
describe("responseCarriesStructuredContent", () => {
  test("true only when an envelope actually carries structuredContent", () => {
    expect(responseCarriesStructuredContent(createStructuredToolResponse({ success: true }))).toBe(
      true,
    );
    expect(responseCarriesStructuredContent({ structuredContent: { a: 1 } })).toBe(true);
  });

  test("false for envelopes without the field, primitives, and null/undefined", () => {
    expect(responseCarriesStructuredContent({ content: [{ type: "text", text: "hi" }] })).toBe(
      false,
    );
    expect(responseCarriesStructuredContent({})).toBe(false);
    expect(responseCarriesStructuredContent(null)).toBe(false);
    expect(responseCarriesStructuredContent(undefined)).toBe(false);
    expect(responseCarriesStructuredContent("plain")).toBe(false);
    expect(responseCarriesStructuredContent(42)).toBe(false);
  });
});

/**
 * `structuredContentOmissionReason` is the single source of truth for the
 * omission decision (issue #2962): the wire strip derives `shouldStrip` from it,
 * and `index.ts` uses it to emit the debug trace. It must classify WHY the field
 * is omitted so the debug line can name the reason.
 *
 * Matrix (hasOutputSchema x flag):
 *   hasOutputSchema | flag  | reason
 *   ----------------|-------|-----------
 *   false           | off   | "no-schema"   (#2759 unconditional, precedes flag)
 *   false           | on    | "no-schema"   (still no-schema, not "flag")
 *   true            | off   | null          (retained — no omission)
 *   true            | on    | "flag"        (#2899)
 */
describe("structuredContentOmissionReason", () => {
  let original: boolean;

  beforeEach(() => {
    original = serverConfig.isToolResultsNoStructuredContentEnabled();
  });

  afterEach(() => {
    serverConfig.setToolResultsNoStructuredContentEnabled(original);
  });

  describe("explicit flag argument (pure, no serverConfig dependency)", () => {
    test("no-schema + flag off → 'no-schema'", () => {
      expect(structuredContentOmissionReason(false, false)).toBe("no-schema");
    });

    test("no-schema + flag on → 'no-schema' (unconditional strip precedes the flag)", () => {
      expect(structuredContentOmissionReason(false, true)).toBe("no-schema");
    });

    test("schema + flag off → null (structuredContent is retained)", () => {
      expect(structuredContentOmissionReason(true, false)).toBeNull();
    });

    test("schema + flag on → 'flag'", () => {
      expect(structuredContentOmissionReason(true, true)).toBe("flag");
    });
  });

  describe("defaults to the live serverConfig flag when omitted", () => {
    test("schema tool follows the flag: null when off, 'flag' when on", () => {
      serverConfig.setToolResultsNoStructuredContentEnabled(false);
      expect(structuredContentOmissionReason(true)).toBeNull();
      serverConfig.setToolResultsNoStructuredContentEnabled(true);
      expect(structuredContentOmissionReason(true)).toBe("flag");
    });

    test("no-schema tool is 'no-schema' regardless of the live flag", () => {
      serverConfig.setToolResultsNoStructuredContentEnabled(false);
      expect(structuredContentOmissionReason(false)).toBe("no-schema");
      serverConfig.setToolResultsNoStructuredContentEnabled(true);
      expect(structuredContentOmissionReason(false)).toBe("no-schema");
    });
  });

  test("drives the strip end-to-end: reason === null iff structuredContent kept across the full matrix", () => {
    for (const hasSchema of [true, false]) {
      for (const flag of [true, false]) {
        const reason = structuredContentOmissionReason(hasSchema, flag);
        const response = stripToolResultStructuredContent(
          createStructuredToolResponse({ success: true }),
          reason,
        );
        const kept = "structuredContent" in response;
        expect(kept).toBe(reason === null);
      }
    }
  });
});
