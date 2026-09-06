import { describe, expect, test } from "bun:test";
import { toJSONSchema } from "zod/v4";
import {
  elementBoundsSchema,
  elementSchema,
  observationOutputSchema,
  observationSummarySchema,
  observeDiffSchema,
  observeResultSchema,
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

  test("elementSchema advertises compact semantic-link metadata", () => {
    const element = elementSchema.parse({
      bounds: tupleBounds,
      text: "Read Terms of Service",
      "semantic-links": [{ text: "Terms of Service", occurrence: 0, start: 5, end: 21 }],
    });

    expect(element["semantic-links"]).toEqual([
      { text: "Terms of Service", occurrence: 0, start: 5, end: 21 },
    ]);
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

/**
 * `observation` as a discriminated union of a full observation and a compact
 * diff (issue #6221 item 4). The discriminator is `isDiff`: present and `true`
 * on the diff arm, absent on the full arm. Both arms must validate through the
 * SAME schema a client would use to decode `tapOnResultSchema.observation`.
 */
describe("observationOutputSchema: discriminated union of full observation vs diff (#6221 item 4)", () => {
  test("accepts a full observation (no `isDiff`)", () => {
    const full = { activeWindow: { appId: "com.example" } };
    const parsed = observationOutputSchema.parse(full);
    expect((parsed as Record<string, unknown>).isDiff).toBeUndefined();
  });

  test("accepts a diff (`isDiff: true`) that ALWAYS carries a `skeleton`", () => {
    const diff = {
      isDiff: true,
      skeleton: [
        {
          elementId: "com.example:id/btn",
          label: "Submit",
          bounds: [0, 0, 100, 50],
          affordances: ["tap"],
        },
      ],
      added: [],
      removed: [],
      changed: [],
    };
    const parsed = observeDiffSchema.parse(diff);
    expect(parsed.isDiff).toBe(true);
    expect(parsed.skeleton).toHaveLength(1);

    // Also parses through the full union tapOnResultSchema.observation uses.
    const viaUnion = observationOutputSchema.parse(diff);
    expect((viaUnion as { isDiff?: true }).isDiff).toBe(true);
  });

  test("rejects a diff with no `skeleton` at all (item 4.1: it must ALWAYS be present)", () => {
    const diffMissingSkeleton = { isDiff: true, added: [], removed: [], changed: [] };
    expect(() => observeDiffSchema.parse(diffMissingSkeleton)).toThrow();
  });

  test("the FULL union rejects a malformed diff — it cannot silently fall through to the permissive full-observation arm (PR #6242 review PRRT_kwDOP-GF5M6fq3iN)", () => {
    // Before the fix, this object failed `observeDiffSchema` (missing the
    // mandatory `skeleton`) but then matched `observationSummarySchema` anyway,
    // since every field there was optional and `.passthrough()` let `isDiff`
    // and the rest ride through unchecked.
    const malformedDiff = { isDiff: true, added: [], removed: [], changed: [] };
    expect(() => observationOutputSchema.parse(malformedDiff)).toThrow();
  });

  test("observationSummarySchema itself rejects `isDiff: true` — it is a genuinely-typed member, not just permissively passed through", () => {
    expect(() =>
      observationSummarySchema.parse({ isDiff: true, activeWindow: { appId: "com.example" } }),
    ).toThrow();
    // `isDiff` absent, or explicitly `false`, both still validate.
    expect(() =>
      observationSummarySchema.parse({ activeWindow: { appId: "com.example" } }),
    ).not.toThrow();
    expect(() =>
      observationSummarySchema.parse({ isDiff: false, activeWindow: { appId: "com.example" } }),
    ).not.toThrow();
  });

  test("a diff's added/removed nodes carry their real selector fields directly in `attributes` (no redundant `selector`)", () => {
    const diff = {
      isDiff: true,
      skeleton: [],
      added: [
        {
          key: " 109,837,971,1424  0",
          attributes: { "resource-id": "com.example:id/new", text: "New row" },
        },
      ],
      removed: [],
      changed: [],
    };
    const parsed = observeDiffSchema.parse(diff);
    expect(parsed.added[0].attributes["resource-id"]).toBe("com.example:id/new");
    // Internal key still validates (it's a plain string) but is documented
    // as non-selector — see the schema's own `.describe()`.
    expect(parsed.added[0].key).toBe(" 109,837,971,1424  0");
  });

  test("a diff's `changed` entries carry a real `selector` distinct from the internal `key`", () => {
    const diff = {
      isDiff: true,
      skeleton: [],
      added: [],
      removed: [],
      changed: [
        {
          key: " 109,837,971,1424  0",
          selector: { elementId: "com.example:id/toggle", label: "Airplane mode" },
          changes: { checked: { from: undefined, to: "true" } },
        },
      ],
    };
    const parsed = observeDiffSchema.parse(diff);
    expect(parsed.changed[0].selector).toEqual({
      elementId: "com.example:id/toggle",
      label: "Airplane mode",
    });
  });

  test("still accepts a spilled artifact-metadata observation (the third union arm)", () => {
    const artifact = {
      artifact: {
        path: "/tmp/x.json",
        format: "json",
        payload: "ObserveResult",
        bytes: 10,
        tool: "tapOn",
      },
    };
    expect(() => observationOutputSchema.parse(artifact)).not.toThrow();
    expect(() => toolOutputArtifactMetadataSchema.parse(artifact)).not.toThrow();
  });
});

/**
 * `context` sibling array on `observeResultSchema` (issue #6221 item 1): the
 * non-actionable rows the same projection that produces `skeleton` emits.
 */
describe("observeResultSchema: context array (#6221 item 1)", () => {
  test("accepts skeleton + context side by side", () => {
    const result = {
      skeleton: [
        {
          elementId: "com.example:id/btn",
          bounds: [0, 0, 100, 50],
          affordances: ["tap"],
        },
      ],
      context: [
        {
          elementId: "com.android.systemui:status-bar-summary",
          label: "Status bar: 7:09, Wifi signal full.",
          bounds: [0, 0, 1080, 60],
          affordances: [],
        },
      ],
    };
    const parsed = observeResultSchema.parse(result);
    expect(parsed.context).toHaveLength(1);
    expect(parsed.context![0].affordances).toEqual([]);
  });

  test("context is optional (omitted when nothing non-actionable survived)", () => {
    const result = { skeleton: [] };
    const parsed = observeResultSchema.parse(result);
    expect(parsed.context).toBeUndefined();
  });
});
