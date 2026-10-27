import { beforeAll, describe, expect, test } from "bun:test";
import { FakeArtifactWriter } from "../fakes/FakeArtifactWriter";
import visibleCapture from "../fixtures/observe-output/ios-keyboard-states/ios-keyboard-visible.raw.json";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { observationOutputSchema } from "../../src/server/toolOutputSchemas";

function containsExtras(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  return Object.entries(value).some(([key, child]) => key === "extras" || containsExtras(child));
}

// Captured parser output, never a hand-built hierarchy fixture.
let observation: Record<string, unknown>;
let capturedResponse: ReturnType<typeof createStructuredToolResponse>;
let previousStructuredBytes: number;
beforeAll(() => {
  observation = structuredClone(visibleCapture);
  capturedResponse = createStructuredToolResponse(observation);
  const previous = finalizeToolResponse(createStructuredToolResponse(observation), {
    name: "observe",
    args: { raw: true, includeExtras: true },
  });
  previousStructuredBytes = Buffer.byteLength(JSON.stringify(previous.structuredContent));
});

describe("structured tool payload parity", () => {
  test.each([false, undefined])("observe strips nested extras by default (%s)", (includeExtras) => {
    const response = finalizeToolResponse(createStructuredToolResponse(observation), {
      name: "observe",
      args: { project: "full", includeExtras },
    });
    expect(response.structuredContent).toEqual(JSON.parse(response.content[0].text));
    expect(containsExtras(response.structuredContent)).toBe(false);
    expect(observationOutputSchema.safeParse(response.structuredContent).success).toBe(true);
    expect(containsExtras(observation)).toBe(true);
  });

  test("includeExtras preserves structured metadata while text stays compact", () => {
    const response = finalizeToolResponse(createStructuredToolResponse(observation), {
      name: "observe",
      args: { raw: true, includeExtras: true },
    });
    expect(containsExtras(response.structuredContent)).toBe(true);
    expect(containsExtras(JSON.parse(response.content[0].text))).toBe(false);
  });

  test("action observation strips nested extras", () => {
    const response = finalizeToolResponse(
      createStructuredToolResponse({ success: true, observation }),
      { name: "tapOn", args: { project: "full" } },
    );
    expect(response.structuredContent).toEqual(JSON.parse(response.content[0].text));
    expect(containsExtras(response.structuredContent)).toBe(false);
  });

  test("unchanged non-observation payload strips top-level extras on the early exit", () => {
    const response = finalizeToolResponse(
      createStructuredToolResponse<Record<string, unknown>>({
        success: true,
        value: 1,
        extras: { diagnostic: true },
      }),
      { name: "fixture" },
    );
    expect(response.structuredContent).toEqual({ success: true, value: 1 });
    expect(response.structuredContent).toEqual(JSON.parse(response.content[0].text));
    expect(response.success).toBe(true);
  });

  test("stripped extras alone do not trigger the structured hard ceiling", () => {
    const writer = new FakeArtifactWriter();
    const response = finalizeToolResponse(
      createStructuredToolResponse<Record<string, unknown>>({
        success: true,
        extras: { diagnostic: "x".repeat(70_000) },
      }),
      { name: "fixture", artifactWriter: writer, artifactMode: "oversized" },
    );
    expect(writer.writes).toHaveLength(0);
    expect(response.structuredContent).toEqual({ success: true });
    expect(response.structuredContent).toEqual(JSON.parse(response.content[0].text));
  });

  test("includeExtras preserves an otherwise unchanged non-observation envelope", () => {
    const payload = { success: true, extras: { diagnostic: true } };
    const response = finalizeToolResponse(createStructuredToolResponse(payload), {
      name: "fixture",
      args: { includeExtras: true },
    });
    expect(response.structuredContent).toBe(payload);
    expect(containsExtras(JSON.parse(response.content[0].text))).toBe(false);
  });

  test("unchanged payload without extras retains its reference", () => {
    const payload = { success: true, value: 1 };
    const response = finalizeToolResponse(createStructuredToolResponse(payload), {
      name: "fixture",
    });
    expect(response.structuredContent).toBe(payload);
  });

  test("internal observation consumers retain extras", () => {
    const response = finalizeToolResponse(createStructuredToolResponse(observation), {
      name: "observe",
      internal: true,
      args: { raw: true },
    });
    expect(containsExtras(response.structuredContent)).toBe(true);
  });

  test("failed envelope keeps the error in text and hoisted fields", () => {
    const response = finalizeToolResponse(
      {
        ...createStructuredToolResponse({ success: false, error: "fixture failure", observation }),
        isError: true,
      },
      { name: "tapOn", args: { project: "full" } },
    );
    expect(response.isError).toBe(true);
    expect(response.success).toBe(false);
    expect(response.error).toBe("fixture failure");
    expect(response.content[0].text).toContain("fixture failure");
    expect(JSON.parse(response.content[0].text).error).toBe("fixture failure");
    expect(response.structuredContent).toEqual(JSON.parse(response.content[0].text));
  });

  test("captured iOS observe structured bytes match text and shrink from unstripped output", () => {
    const response = finalizeToolResponse(capturedResponse, {
      name: "observe",
      args: { raw: true },
    });
    const structuredBytes = Buffer.byteLength(JSON.stringify(response.structuredContent));
    const textBytes = Buffer.byteLength(response.content[0].text);
    const sizes = `stripped structured=${structuredBytes}, previous unstripped structured=${previousStructuredBytes}, text=${textBytes}`;
    expect(structuredBytes, sizes).toBe(textBytes);
    expect(structuredBytes, sizes).toBeLessThan(previousStructuredBytes);
  });
});
