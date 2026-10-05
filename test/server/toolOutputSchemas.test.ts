import generatedDefinitions from "../../schemas/tool-definitions.json";
import {
  startDeviceOutputSchema,
  pressButtonResultSchema,
  wakeAndUnlockResultSchema,
  launchAppResultSchema,
  terminateAppResultSchema,
  getDeviceStateResultSchema,
  setDeviceStateResultSchema,
} from "../../src/server/toolOutputSchemas";
import type { DeviceStateResult } from "../../src/features/utility/DeviceState";
import { describe, expect, test } from "bun:test";
import { toJSONSchema } from "zod/v4";
import {
  elementBoundsSchema,
  freshnessSchema,
  elementSchema,
  observationOutputSchema,
  observationSummarySchema,
  observeCropResultSchema,
  observeDiffSchema,
  observeResultSchema,
  screenSizeSchema,
  tapOnResultSchema,
  toolOutputArtifactMetadataSchema,
  viewHierarchyResultSchema,
} from "../../src/server/toolOutputSchemas";

test("freshness schema accepts bounded machine-readable unavailability", () => {
  const fields = {
    isFresh: false,
    unavailableReason: "device_locked",
    unavailableDetail: "Unlock the device",
  };
  expect(freshnessSchema.parse(fields)).toEqual(fields);
  expect(() => freshnessSchema.parse({ ...fields, unavailableReason: "bad_reason" })).toThrow();
  expect(() => freshnessSchema.parse({ ...fields, unavailableDetail: "x".repeat(501) })).toThrow();
});

test("observe advertises optional typed per-panel observations", () => {
  const stamp = { key: "cover", role: "cover", posture: "unknown", generation: 0 };
  const entry = {
    display: stamp,
    screenSize: { width: 100, height: 100 },
    skeleton: [],
    freshness: { isFresh: false, unavailableReason: "request_timed_out" },
  };
  const result = { observationId: "capture", deviceId: "android", displays: [entry] };
  expect(observeResultSchema.parse(result).displays).toEqual([entry]);
  expect(
    observeResultSchema.safeParse({ ...result, displays: [{ ...entry, display: undefined }] })
      .success,
  ).toBe(false);
  expect(
    observeResultSchema.safeParse({
      ...result,
      displays: [{ ...entry, freshness: { isFresh: false, unavailableReason: "bad_reason" } }],
    }).success,
  ).toBe(false);
  const schema = toJSONSchema(observeResultSchema);
  expect(schema.required ?? []).not.toContain("displays");
  expect(schema.properties?.displays).toBeDefined();
});

test("full action observation advertises the optional freshness reason fields", () => {
  const full = toJSONSchema(observationSummarySchema);
  const freshness = full.properties?.freshness;
  expect(full.required ?? []).not.toContain("freshness");
  expect(JSON.stringify(freshness)).toContain("unavailableReason");
  expect(JSON.stringify(freshness)).toContain("unavailableDetail");
});
import { applyJsonSchemaOverride } from "../../src/server/toolSchemaHelpers";

test("crop raster description documents upright output without changing full screenshot metadata", () => {
  expect(toJSONSchema(observeCropResultSchema).properties?.imageSize.description).toBe(
    "Pixel dimensions of the upright output crop PNG.",
  );
  expect(
    toJSONSchema(observeResultSchema).properties?.screenshotImageSize.description,
  ).toBeUndefined();
});

test("full screenshot geometry accepts shared crop scalars and rejects invalid raster sizes", () => {
  const fields = {
    screenshotImageSize: { width: 1080, height: 2400 },
    screenshotPixelsPerNativeUnit: { x: 1, y: 1 },
    screenshotScaleProvenance: "raster-dimensions",
  };
  const schema = observeResultSchema.pick({
    screenshotImageSize: true,
    screenshotPixelsPerNativeUnit: true,
    screenshotScaleProvenance: true,
  });
  expect(schema.parse(fields)).toEqual(fields);
  for (const width of [0, -1, 1.5]) {
    expect(
      schema.safeParse({ ...fields, screenshotImageSize: { width, height: 2400 } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...fields, screenshotImageSize: { width: 1080, height: width } }).success,
    ).toBe(false);
  }
});

const observeTruncationReasonsDescription =
  "Why a served observation or diff may be incomplete (issues #6601, #6933). " +
  "On a non-diff skeleton projection, this contains only capture-fidelity reasons " +
  "(device-side max_nodes, max_depth, max_children, cancelled); its presence means `skeleton`/" +
  "`context` omit rows. A host-output max_children[<node> kept N of M] cap trims " +
  "only rendered `viewHierarchy` and is not lifted to a non-diff skeleton. On a " +
  "diff, any reason — host-cap (max_children[...]) or capture-fidelity (max_nodes, " +
  "max_depth, max_children, cancelled) — may originate from either comparison input (baseline or " +
  "current capture), so its presence means the comparison may be incomplete rather " +
  "than that the current `skeleton`/`context` omit rows (issue #6933).";

const observationSummaryTruncationReasonsDescription =
  "Why the captured hierarchy is incomplete (issue #6601) — the same field " +
  "a diff-mode observation carries, so a client reads it the same way in both " +
  "modes. On this non-diff arm, it contains only capture-fidelity reasons " +
  "(device-side max_nodes, max_depth, max_children, cancelled); its presence means " +
  "`skeleton`/`context` omit rows. A host-output max_children[<node> kept N of M] " +
  "cap trims only rendered `viewHierarchy` and is not lifted here.";

const observeDiffTruncationReasonsDescription =
  "Why the captured hierarchy is incomplete (issue #6601) — the same field a " +
  "full observation carries, so a client reads it the same way in both modes. " +
  "In diff mode (issue #6933), any reason — host-cap (max_children[...]) or " +
  "capture-fidelity (max_nodes, max_depth, max_children, cancelled) — may originate from either " +
  "comparison input (baseline or current capture), so its presence means the " +
  "comparison may be incomplete, not that this diff's own `skeleton`/`context` " +
  "omit rows.";

const viewHierarchyTruncationReasonsDescription =
  "Why the captured hierarchy is incomplete (issue #6601). Present only when " +
  "rows were dropped — a device-side stop (max_nodes, max_depth, max_children, cancelled) or the " +
  "host per-node child cap (max_children[<node> kept N of M]). This is the nested " +
  "location `sanitizeObserveResult` leaves raw hierarchy reasons under " +
  '`project:"full"` or `raw:true`; capture-fidelity reasons may also be lifted ' +
  "to the top-level `truncationReasons` field for skeleton/diff output, while a " +
  "host-output max_children cap is not lifted to a non-diff skeleton.";

test("truncationReasons descriptions distinguish skeleton completeness from diff-input caps (#6933)", () => {
  const descriptions = [
    [observeResultSchema, observeTruncationReasonsDescription],
    [observationSummarySchema, observationSummaryTruncationReasonsDescription],
    [observeDiffSchema, observeDiffTruncationReasonsDescription],
    [viewHierarchyResultSchema, viewHierarchyTruncationReasonsDescription],
  ] as const;

  for (const [schema, expectedDescription] of descriptions) {
    expect(schema.shape.truncationReasons.description).toBe(expectedDescription);
  }
});

describe("screenSizeSchema coordinate units (#7371)", () => {
  test("accepts the shared inset-unit vocabulary without changing dimensions", () => {
    const dimensions = { width: 393, height: 852 };

    expect(screenSizeSchema.parse({ ...dimensions, units: "points" })).toEqual({
      ...dimensions,
      units: "points",
    });
    expect(screenSizeSchema.parse({ ...dimensions, units: "physical-pixels" })).toEqual({
      ...dimensions,
      units: "physical-pixels",
    });
    expect(screenSizeSchema.parse(dimensions)).toEqual(dimensions);
  });

  test("rejects an unknown coordinate-unit spelling", () => {
    expect(() =>
      screenSizeSchema.parse({ width: 393, height: 852, units: "logical-points" }),
    ).toThrow();
  });
});

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

describe("accessibility audit skip metadata schema (#6926)", () => {
  const accessibilityAuditSkipped = "settled_capture_adopted" as const;

  test("observation summaries accept and preserve the skip reason", () => {
    expect(
      observationSummarySchema.parse({ observationId: "summary", accessibilityAuditSkipped }),
    ).toMatchObject({
      accessibilityAuditSkipped,
    });
  });

  test("diff observations accept the skip reason", () => {
    expect(
      observeDiffSchema.parse({
        observationId: "diff",
        isDiff: true,
        skeleton: [],
        added: [],
        removed: [],
        changed: [],
        accessibilityAuditSkipped,
      }),
    ).toMatchObject({ accessibilityAuditSkipped });
  });

  test("full observe results accept the skip reason", () => {
    expect(
      observeResultSchema.parse({ observationId: "result", accessibilityAuditSkipped }),
    ).toMatchObject({
      accessibilityAuditSkipped,
    });
  });

  test("rejects an invalid skip reason", () => {
    expect(() =>
      observationSummarySchema.parse({
        observationId: "summary",
        accessibilityAuditSkipped: "bogus",
      }),
    ).toThrow();
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
    const full = { observationId: "full", activeWindow: { appId: "com.example" } };
    const parsed = observationOutputSchema.parse(full);
    expect((parsed as Record<string, unknown>).isDiff).toBeUndefined();
  });

  test("accepts a diff (`isDiff: true`) that ALWAYS carries a `skeleton`", () => {
    const diff = {
      observationId: "diff",
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
      observationSummarySchema.parse({
        observationId: "summary",
        isDiff: true,
        activeWindow: { appId: "com.example" },
      }),
    ).toThrow();
    // `isDiff` absent, or explicitly `false`, both still validate.
    expect(() =>
      observationSummarySchema.parse({
        observationId: "summary",
        activeWindow: { appId: "com.example" },
      }),
    ).not.toThrow();
    expect(() =>
      observationSummarySchema.parse({
        observationId: "summary",
        isDiff: false,
        activeWindow: { appId: "com.example" },
      }),
    ).not.toThrow();
  });

  test("a diff's added/removed nodes carry their real selector fields directly in `attributes` (no redundant `selector`)", () => {
    const diff = {
      observationId: "diff",
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
      observationId: "diff",
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

describe("observationSummarySchema: truncation reasons (#6601)", () => {
  test("declares and preserves truncation reasons on a full action observation", () => {
    const full = {
      observationId: "summary",
      activeWindow: { appId: "com.example" },
      truncationReasons: ["max_children[root] kept 10 of 12"],
    };

    const parsed = observationSummarySchema.parse(full);
    expect(parsed.truncationReasons).toEqual(full.truncationReasons);

    const json = toJSONSchema(observationSummarySchema) as Record<string, any>;
    expect(json.properties.truncationReasons).toBeDefined();
    expect(json.required ?? []).not.toContain("truncationReasons");
  });

  test("declares nested hierarchy truncation reasons on full/raw action observations", () => {
    const full = {
      observationId: "summary",
      activeWindow: { appId: "com.example" },
      viewHierarchy: {
        hierarchy: { node: { bounds: [0, 0, 100, 50] } },
        truncationReasons: ["max_children[root] kept 10 of 12"],
      },
    };

    const parsed = observationOutputSchema.parse(full);
    expect(parsed.viewHierarchy?.truncationReasons).toEqual(full.viewHierarchy.truncationReasons);

    const json = toJSONSchema(observationSummarySchema) as Record<string, any>;
    const viewHierarchy = json.properties.viewHierarchy as Record<string, any>;
    const viewHierarchySchema = viewHierarchy.$ref
      ? (json.$defs[viewHierarchy.$ref.replace("#/$defs/", "")] as Record<string, any>)
      : viewHierarchy;
    expect(viewHierarchySchema.properties.truncationReasons).toBeDefined();
  });
});

describe("viewHierarchyResultSchema: nested truncation reasons (#6601)", () => {
  test("declares and preserves truncation reasons on a full/raw hierarchy", () => {
    const viewHierarchy = {
      truncationReasons: ["max_children[root] kept 10 of 12"],
    };

    const parsed = viewHierarchyResultSchema.parse(viewHierarchy);
    expect(parsed.truncationReasons).toEqual(viewHierarchy.truncationReasons);

    const json = toJSONSchema(viewHierarchyResultSchema) as Record<string, any>;
    expect(json.properties.truncationReasons).toBeDefined();
    expect(json.required ?? []).not.toContain("truncationReasons");
  });
});

/**
 * `context` sibling array on `observeResultSchema` (issue #6221 item 1): the
 * non-actionable rows the same projection that produces `skeleton` emits.
 */
describe("observeResultSchema: context array (#6221 item 1)", () => {
  test("accepts skeleton + context side by side", () => {
    const result = {
      observationId: "result",
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
    const result = { observationId: "result", skeleton: [] };
    const parsed = observeResultSchema.parse(result);
    expect(parsed.context).toBeUndefined();
  });
});

/**
 * `settled` (issue #6866) is stamped onto EVERY embedded action observation —
 * full arm and diff arm alike — so a client can tell a stability-checked capture
 * from an unchecked one. A passthrough schema tolerates the wire value, but a
 * schema-driven client or a generated type can only discover the accessor if
 * both arms declare it.
 */
describe("observation arms advertise `settled` (#6866)", () => {
  test("the full-observation arm declares it", () => {
    const json = toJSONSchema(observationSummarySchema) as Record<string, any>;
    expect(json.properties.settled).toBeDefined();
    expect(json.properties.settled.type).toBe("boolean");
    expect(json.required ?? []).not.toContain("settled");
  });

  test("the diff arm declares it", () => {
    const json = toJSONSchema(observeDiffSchema) as Record<string, any>;
    expect(json.properties.settled).toBeDefined();
    expect(json.properties.settled.type).toBe("boolean");
    expect(json.required ?? []).not.toContain("settled");
  });

  test("a generated action-tool output schema therefore carries it on the observation", () => {
    expect(JSON.stringify(toJSONSchema(tapOnResultSchema))).toContain('"settled"');
  });

  test("both arms still accept an observation carrying the flag", () => {
    expect(
      observationSummarySchema.parse({ observationId: "summary", settled: true }).settled,
    ).toBe(true);
    expect(
      observeDiffSchema.parse({
        observationId: "diff",
        isDiff: true,
        skeleton: [],
        added: [],
        removed: [],
        changed: [],
        settled: false,
      }).settled,
    ).toBe(false);
  });
});

describe("observation arms advertise observationId resource join keys", () => {
  test("the parse schema still accepts recorded captures that predate the join key", () => {
    // Historical fixtures (test/fixtures/observe) were captured before
    // `observationId` existed; the same zod schema validates them, so parsing
    // must not require the field even though every emitted observation carries it.
    expect(() => observeResultSchema.parse({})).not.toThrow();
    expect(() => observationSummarySchema.parse({})).not.toThrow();
    expect(() =>
      observeDiffSchema.parse({ isDiff: true, skeleton: [], added: [], removed: [], changed: [] }),
    ).not.toThrow();
  });

  test("full observe, full action summary, and diff schemas parse it as a string", () => {
    const observationId = "observation-123";

    expect(observeResultSchema.parse({ observationId }).observationId).toBe(observationId);
    expect(observationSummarySchema.parse({ observationId }).observationId).toBe(observationId);
    expect(
      observeDiffSchema.parse({
        isDiff: true,
        skeleton: [],
        added: [],
        removed: [],
        changed: [],
        observationId,
      }).observationId,
    ).toBe(observationId);
  });

  test("each advertised schema requires the join key on the wire while parsing keeps it optional", () => {
    for (const schema of [observeResultSchema, observationSummarySchema, observeDiffSchema]) {
      const raw = toJSONSchema(schema) as Record<string, any>;
      expect(raw.properties.observationId.type).toBe("string");
      expect(raw.required ?? []).not.toContain("observationId");

      // The registry advertises through the same `applyJsonSchemaOverride` seam.
      const advertised = toJSONSchema(schema, {
        override: ({ zodSchema, jsonSchema }) => applyJsonSchemaOverride(zodSchema, jsonSchema),
      }) as Record<string, any>;
      expect(advertised.properties.observationId.type).toBe("string");
      expect(advertised.required).toContain("observationId");
      // `required` follows property order so the generated tool definitions stay stable.
      const propertyOrder = Object.keys(advertised.properties);
      const requiredOrder = (advertised.required as string[]).map((key) =>
        propertyOrder.indexOf(key),
      );
      expect(requiredOrder).toEqual([...requiredOrder].sort((a, b) => a - b));
      const keyOrder = Object.keys(advertised);
      expect(keyOrder.indexOf("required")).toBeLessThan(keyOrder.indexOf("additionalProperties"));
    }
  });
});

const lifecycleSchemas = [
  startDeviceOutputSchema,
  pressButtonResultSchema,
  wakeAndUnlockResultSchema,
  launchAppResultSchema,
  terminateAppResultSchema,
  getDeviceStateResultSchema,
  setDeviceStateResultSchema,
];
test.each(lifecycleSchemas)(
  "lifecycle object schemas require only message and permit extra variant metadata",
  (schema) => {
    expect(toJSONSchema(schema).required).toEqual(["message"]);
    expect(schema.parse({ message: "Result", futureMetadata: true })).toEqual({
      message: "Result",
      futureMetadata: true,
    });
    expect(schema.safeParse({ success: true }).success).toBe(false);
  },
);

const fieldVariants: Array<Partial<DeviceStateResult>> = [
  { clock: { supported: false, capability: "unsupported", error: "unsupported" } },
  { clock: { supported: true, capability: "full", error: "probe failed" } },
  ...(["changed", "unchanged", "restored"] as const).map((outcome) => ({
    clock: { supported: true, capability: "full" as const, verified: true, outcome },
  })),
  {
    doNotDisturb: {
      supported: true,
      capability: "full",
      enabled: true,
      mode: "priority",
      verified: true,
    },
  },
  {
    doNotDisturb: {
      supported: true,
      capability: "binary",
      requestedMode: "alarms",
      appliedMode: "none",
      bestEffort: true,
    },
  },
  {
    doNotDisturb: {
      supported: false,
      capability: "unsupported",
      requestedMode: "off",
      verified: false,
      error: "unsupported",
    },
  },
  { doNotDisturb: { supported: true, capability: "full", error: "failed" } },
  { doNotDisturb: { supported: true, capability: "full", verified: false, warning: "mismatch" } },
  { biometrics: { supported: true, enrollment: "enrolled", verified: true } },
  {
    biometrics: {
      supported: false,
      enrollment: "not_enrolled",
      verified: false,
      error: "unsupported",
    },
  },
  { biometrics: { supported: true, verified: false, error: "read failed" } },
  { connectivity: { supported: false, verified: false, error: "unsupported" } },
  {
    connectivity: {
      supported: true,
      wifiEnabled: false,
      verified: true,
      rawValues: { wifiEnabled: "0" },
    },
  },
  { connectivity: { supported: true, airplaneMode: true, warning: "partial read" } },
  { connectivity: { supported: true, verified: false, warning: "write mismatch" } },
  { connectivity: { supported: true, error: "read failed" } },
  {
    networkCondition: {
      supported: false,
      capability: "unsupported",
      requestedProfile: "offline",
      verified: false,
      error: "unsupported",
    },
  },
  { networkCondition: { supported: true, capability: "full", profile: "none", verified: true } },
  {
    networkCondition: {
      supported: true,
      capability: "partial",
      appliedProfile: "3g",
      warning: "cellular only",
    },
  },
  {
    networkCondition: {
      supported: true,
      capability: "partial",
      verified: false,
      error: "reset failed",
    },
  },
  {
    networkCondition: {
      supported: true,
      capability: "full",
      rawStatus: "speed: full",
      observedValues: { delayMs: 0 },
    },
  },
  { location: { supported: false, error: "unsupported" } },
  {
    location: {
      supported: true,
      error: "command failed",
      previousRoute: { endedReason: "failed", lastError: "emit failed" },
    },
  },
  {
    location: {
      supported: true,
      mode: "static",
      latitude: 0,
      longitude: 1,
      previousRoute: { endedReason: "replaced" },
    },
  },
  {
    location: {
      supported: true,
      mode: "route",
      waypointCount: 2,
      loop: false,
      expectedDurationMs: 1000,
      previousRoute: { endedReason: "completed" },
    },
  },
  {
    location: {
      supported: true,
      mode: "stop",
      stopped: true,
      previousRoute: { endedReason: "stopped" },
    },
  },
  { location: { supported: true, mode: "stop", stopped: false } },
];
test.each(fieldVariants)("device-state field variant validates (%j)", (fields) => {
  const payload = {
    message: "Result",
    success: true,
    deviceId: "fake",
    platform: "android",
    ...fields,
  };
  expect(getDeviceStateResultSchema.parse(payload)).toEqual(payload);
  expect(setDeviceStateResultSchema.parse(payload)).toEqual(payload);
});

test("device-state output checks shared enums and field types", () => {
  expect(
    setDeviceStateResultSchema.safeParse({
      message: "Result",
      biometrics: { supported: true, enrollment: "invalid" },
    }).success,
  ).toBe(false);
  expect(
    setDeviceStateResultSchema.safeParse({
      message: "Result",
      networkCondition: { supported: true, profile: "5g" },
    }).success,
  ).toBe(false);
  expect(
    getDeviceStateResultSchema.safeParse({
      message: "Result",
      connectivity: { supported: true, wifiEnabled: "off" },
    }).success,
  ).toBe(false);
});

test("observationDiff declares an optional string hint and preserves reason enum values", () => {
  const metadataSchema = pressButtonResultSchema.shape.observationDiff.unwrap();
  const reasons = [
    "diff_emitted",
    "missing_baseline",
    "screen_changed",
    "missing_session",
    "unrenderable_hierarchy",
    "disabled",
    "stripped_by_actions_no_observe",
  ];
  for (const reason of reasons) {
    const metadata = { mode: "full", reason, hint: "Pass sessionUuid to receive diffs" };
    expect(metadataSchema.parse(metadata)).toEqual(metadata);
    expect(metadataSchema.safeParse({ mode: "full", reason }).success).toBe(true);
  }
  expect(
    metadataSchema.safeParse({
      mode: "full",
      reason:
        "missing_session — pass sessionUuid from getAndroid/getApple to receive diffs instead of full observations",
    }).success,
  ).toBe(false);
  expect(metadataSchema.safeParse({ mode: "full", reason: "disabled", hint: 123 }).success).toBe(
    false,
  );
  const schema = toJSONSchema(metadataSchema);
  expect(schema.properties?.hint).toEqual({ type: "string" });
  expect(schema.required ?? []).not.toContain("hint");
  expect(schema.properties?.reason).toEqual({ type: "string", enum: reasons });
});

// Walk every declared action output, including per-tool unions, without registry/DB setup.
interface CompactMetadataJsonSchema {
  properties?: Record<string, CompactMetadataJsonSchema>;
  required?: string[];
  anyOf?: CompactMetadataJsonSchema[];
  oneOf?: CompactMetadataJsonSchema[];
  allOf?: CompactMetadataJsonSchema[];
  additionalProperties?: unknown;
}
function schemaArms(schema: CompactMetadataJsonSchema): CompactMetadataJsonSchema[] {
  return [
    schema,
    ...[...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])].flatMap(
      schemaArms,
    ),
  ];
}
test("all action schemas allow compact metadata and duplicate-element omissions", () => {
  const fields = [
    "insets",
    "systemInsets",
    "backStack",
    "gfxMetrics",
    "displayedTimeMetrics",
    "deviceLock",
    "accessibilityState",
    "freshness",
  ];
  let observations = 0;
  const definitions: readonly { name: string; outputSchema?: CompactMetadataJsonSchema }[] =
    generatedDefinitions;
  for (const definition of definitions) {
    if (definition.name === "observe" || !definition.outputSchema) {
      continue;
    }
    for (const arm of schemaArms(definition.outputSchema)) {
      if (arm.properties?.element) {
        expect(arm.required ?? []).not.toContain("element");
      }
      const observation = arm.properties?.observation;
      if (!observation) {
        continue;
      }
      observations++;
      for (const observationArm of schemaArms(observation)) {
        for (const field of fields) {
          expect(observationArm.required ?? []).not.toContain(field);
          if (observationArm.properties && !observationArm.properties[field]) {
            expect(observationArm.additionalProperties).not.toBe(false);
          }
        }
        const hierarchy = observationArm.properties?.viewHierarchy;
        if (hierarchy) {
          for (const hierarchyArm of schemaArms(hierarchy)) {
            expect(hierarchyArm.required ?? []).not.toContain("insets");
            expect(hierarchyArm.required ?? []).not.toContain("systemInsets");
          }
        }
      }
    }
  }
  expect(observations).toBeGreaterThan(0);
});
