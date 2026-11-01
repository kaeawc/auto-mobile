import { describe, expect, test } from "bun:test";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { createStructuredToolResponse, getStructuredPayload } from "../../src/utils/toolUtils";
import type { ObserveResult } from "../../src/models/ObserveResult";

function observeResult(extra: Partial<ObserveResult>): ObserveResult {
  return {
    display: { key: "default", role: "inner", posture: "unknown", generation: 0 },
    observationId: "obs-backend",
    updatedAt: 123,
    screenSize: { width: 402, height: 874 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: {
      packageName: "com.example.app",
      hierarchy: {
        node: {
          "resource-id": "root",
          bounds: { left: 0, top: 0, right: 402, bottom: 874 },
          node: [
            {
              "resource-id": "save",
              text: "Save",
              clickable: "true",
              bounds: { left: 10, top: 10, right: 90, bottom: 40 },
            },
          ],
        },
      },
    },
    ...extra,
  };
}

describe("observe output carries the SDK bridge backend (#5159)", () => {
  test("backend and fallbackReason reach the structured observe result", () => {
    for (const extra of [
      { backend: "sdk" as const },
      { backend: "xctest" as const, fallbackReason: "unavailable" as const },
    ]) {
      const finalized = finalizeToolResponse(createStructuredToolResponse(observeResult(extra)), {
        name: "observe",
      });
      expect(getStructuredPayload<Record<string, unknown>>(finalized)).toMatchObject(extra);
    }
  });

  test("an observation without a bridge carries neither field", () => {
    const finalized = finalizeToolResponse(createStructuredToolResponse(observeResult({})), {
      name: "observe",
    });
    const payload = getStructuredPayload<Record<string, unknown>>(finalized);
    expect(payload).not.toHaveProperty("backend");
    expect(payload).not.toHaveProperty("fallbackReason");
  });
});
