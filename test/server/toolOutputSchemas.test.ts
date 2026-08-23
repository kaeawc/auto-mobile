import { describe, expect, test } from "bun:test";
import { toJSONSchema } from "zod/v4";
import {
  elementBoundsSchema,
  elementSchema,
  tapOnResultSchema,
  toolOutputArtifactMetadataSchema,
} from "../../src/server/toolOutputSchemas";

/**
 * Wire-schema coverage for the `--observe-result-compact` tuple form (issue #2990,
 * task 2). When the flag is on, `finalizeToolResponse` flattens every `bounds`
 * object `{left, top, right, bottom}` to the positional tuple `[left, top, right,
 * bottom]`. Tools that advertise an `outputSchema` (tapOn, accessibility, …) all
 * route their `bounds` through `elementBoundsSchema`, so that schema must accept —
 * and machine-readably document — both shapes; otherwise a strict MCP client would
 * reject the compact response and an external consumer could not decode the tuple
 * without reading prose docs.
 */
describe("elementBoundsSchema: object + compact tuple (#2990)", () => {
  const objectBounds = { left: 0, top: 10, right: 1080, bottom: 1920 };
  const tupleBounds = [0, 10, 1080, 1920];

  test("accepts the default object form", () => {
    expect(elementBoundsSchema.parse(objectBounds)).toEqual(objectBounds);
  });

  test("accepts the object form with optional centerX/centerY", () => {
    const withCenters = { ...objectBounds, centerX: 540, centerY: 965 };
    expect(elementBoundsSchema.parse(withCenters)).toEqual(withCenters);
  });

  test("accepts the compact [left, top, right, bottom] tuple", () => {
    expect(elementBoundsSchema.parse(tupleBounds)).toEqual(tupleBounds);
  });

  test("rejects a tuple of the wrong arity", () => {
    expect(() => elementBoundsSchema.parse([0, 10, 1080])).toThrow();
    expect(() => elementBoundsSchema.parse([0, 10, 1080, 1920, 5])).toThrow();
  });

  test("rejects non-numeric tuple members", () => {
    expect(() => elementBoundsSchema.parse([0, 10, 1080, "x"])).toThrow();
  });

  test("elementSchema accepts a node whose bounds is the compact tuple", () => {
    const el = { bounds: tupleBounds, text: "btn" };
    expect(elementSchema.parse(el)).toMatchObject({ bounds: tupleBounds, text: "btn" });
  });

  test("the advertised JSON schema documents the tuple order (machine-readable)", () => {
    const json = JSON.stringify(toJSONSchema(tapOnResultSchema));
    // The union carries a description naming the positional tuple order, so an
    // external client can decode [l,t,r,b] from the wire schema alone. Bounds
    // compaction is now a permanent default, so the tuple is the advertised
    // default form rather than a flag-gated arm.
    expect(json).toContain("left, top, right, bottom");
  });
});

describe("tool output artifact metadata schema (#3480)", () => {
  test("tapOn results advertise confirmed semantic link activation", () => {
    const result = tapOnResultSchema.parse({
      success: true,
      action: "tap",
      activatedSubtext: { text: "Terms of Service", occurrence: 1 },
    });
    const json = JSON.stringify(toJSONSchema(tapOnResultSchema));

    expect(result).toMatchObject({
      activatedSubtext: { text: "Terms of Service", occurrence: 1 },
    });
    expect(json).toContain("activatedSubtext");
    expect(json).toContain("Semantic accessibility link");
  });

  test("advertises screen-reader navigation fidelity assertions (#3963)", () => {
    const json = JSON.stringify(toJSONSchema(tapOnResultSchema));

    expect(json).toContain("screenReaderNavigation");
    expect(json).toContain("reachable");
    expect(json).toContain("traversalOrder");
    expect(json).toContain("focusTrapDetected");
  });

  const metadata = {
    artifact: {
      path: "/tmp/auto-mobile/123-tapOn-id.json",
      format: "json",
      payload: "ObserveResult",
      bytes: 123,
      tool: "tapOn",
    },
  };

  test("accepts the shared artifact metadata shape", () => {
    expect(toolOutputArtifactMetadataSchema.parse(metadata)).toEqual(metadata);
  });

  test("tapOn results accept artifact metadata in the embedded observation field", () => {
    expect(() =>
      tapOnResultSchema.parse({
        success: true,
        observation: metadata,
      }),
    ).not.toThrow();
  });

  test("accepts ObserveDiff artifact metadata for diffed observations", () => {
    expect(
      toolOutputArtifactMetadataSchema.parse({
        artifact: {
          ...metadata.artifact,
          payload: "ObserveDiff",
        },
      }).artifact.payload,
    ).toBe("ObserveDiff");
  });

  test("accepts non-observation artifact payload labels", () => {
    expect(
      toolOutputArtifactMetadataSchema.parse({
        artifact: {
          ...metadata.artifact,
          payload: "NetworkGraph",
          tool: "getNetworkGraph",
        },
      }).artifact.payload,
    ).toBe("NetworkGraph");
  });
});

/**
 * Fractional-coordinate coverage (issue #3206). iOS bounds are XCUITest points,
 * which are legitimately fractional (retina point→pixel thirds, `.5` sub-point
 * layout). The schema previously claimed `z.number().int()`, so a strict MCP
 * client generating a decoder from the advertised `outputSchema` would have
 * rejected a real iOS observation carrying a `.5` coordinate.
 */
describe("elementBoundsSchema: fractional iOS point coordinates (#3206)", () => {
  test("accepts fractional object bounds (the issue's repro)", () => {
    const fractional = { left: 0.5, top: 1.2, right: 100, bottom: 200 };
    expect(elementBoundsSchema.parse(fractional)).toEqual(fractional);
  });

  test("accepts fractional centerX/centerY", () => {
    const withCenters = {
      left: 20.5,
      top: 68.5,
      right: 168.5,
      bottom: 94.5,
      centerX: 94.5,
      centerY: 81.5,
    };
    expect(elementBoundsSchema.parse(withCenters)).toEqual(withCenters);
  });

  test("accepts a fractional compact tuple", () => {
    const tuple = [16.333333333333332, 786.5, 201.66666666666666, 823.5];
    expect(elementBoundsSchema.parse(tuple)).toEqual(tuple);
  });

  test("the advertised JSON schema claims number, not integer, for bounds coordinates", () => {
    const json = toJSONSchema(elementBoundsSchema) as Record<string, unknown>;
    expect(JSON.stringify(json)).not.toContain('"integer"');
  });

  test("still rejects non-numeric bounds values", () => {
    expect(() => elementBoundsSchema.parse({ left: "0.5", top: 1, right: 2, bottom: 3 })).toThrow();
    expect(() => elementBoundsSchema.parse([0.5, 1, 2, "3"])).toThrow();
  });
});
