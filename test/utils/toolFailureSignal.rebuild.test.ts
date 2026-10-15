import { describe, expect, test } from "bun:test";
import { enrichAcquisitionResult } from "../../src/server";
import { isMarkedToolFailure, markToolFailure } from "../../src/utils/toolFailureSignal";
import { createJSONToolResponse, createStructuredToolResponse } from "../../src/utils/toolUtils";

describe("acquisition enrichment failure signal", () => {
  test.each([true, false])("preserves the existing mark on rebuilt content: %s", (marked) => {
    // A failed payload alone must not cause enrichment to invent a mark.
    const payload = { success: false, error: "x" };
    for (const format of [createJSONToolResponse, createStructuredToolResponse]) {
      const original = format(payload);
      const source = { ...original, content: [...original.content] };
      if (marked) {
        markToolFailure(source);
      }
      const fields = { enabledTools: ["observe"] };
      const result = enrichAcquisitionResult(source, fields);
      const enrichedPayload = { ...payload, ...fields };
      const expected = {
        ...source,
        content: [{ type: "text", text: JSON.stringify(enrichedPayload) }],
        ...("structuredContent" in source ? { structuredContent: enrichedPayload } : {}),
      };
      expect(result).not.toBe(source);
      expect(result.content).not.toBe(source.content);
      expect(isMarkedToolFailure(result)).toBe(marked);
      expect(isMarkedToolFailure(result.content)).toBe(marked);
      expect(isMarkedToolFailure({ ...result })).toBe(marked);
      expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
      expect(Reflect.ownKeys(result)).toEqual(Reflect.ownKeys(source));
      expect(Reflect.ownKeys(result.content)).toEqual(["0", "length"]);
      expect(source.content).toEqual(original.content);
      expect(isMarkedToolFailure(source)).toBe(marked);
    }
  });
});
