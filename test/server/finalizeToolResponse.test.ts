import { parseOutputReductionFlags } from "../../src/utils/outputReductionFlags";
import { DefaultFeatureFlagApplier } from "../../src/features/featureFlags/FeatureFlagApplier";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  DEFAULT_OBSERVATION_INLINE_MAX_BYTES,
  DIFF_PASSTHROUGH_METADATA_FIELDS,
  finalizeToolResponse,
  type ObservationArtifactWriter,
  type ObservationArtifactWriteInput,
} from "../../src/server/finalizeToolResponse";
import {
  createStructuredToolResponse,
  getStructuredPayload,
  stringifyToolResponse,
  type StructuredToolResponse,
} from "../../src/utils/toolUtils";
import { serverConfig } from "../../src/utils/ServerConfig";
import { GFXINFO_DUMP_MARKER } from "../../src/features/observe/output/ObserveResultOutput";
import type { ObserveResult } from "../../src/models/ObserveResult";
import { setElementProvenance } from "../../src/features/observe/output/elementProvenance";
import { logger } from "../../src/utils/logger";
import { getDeviceSessionIdFromResult } from "../../src/server/deviceSessionResult";
import { buildObservationScreenshotUri } from "../../src/server/observationResourceUris";
import {
  RESOURCE_URIS as OBSERVATION_RESOURCE_URIS,
  registerObservationResources,
} from "../../src/server/observationResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { z } from "zod/v4";
import realTapOns from "../fixtures/android-action-compact/tapon-consecutive-emulator-5600.json";
import { settleEmbeddedObservationInResponse } from "../../src/server/embeddedObservationSettle";
import { RealSettleObserve } from "../../src/features/observe/SettleObserve";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeScreenshotStateStore } from "../fakes/FakeScreenshotStateStore";
import {
  observationOutputSchema,
  observationSummarySchema,
} from "../../src/server/toolOutputSchemas";
import {
  loadAndroidHomeObserve,
  loadIosFractionalObserve,
} from "../fixtures/observe/observeFixture";

/** Sanitized fixture nodes use the flat wire shape rather than XML's `$` wrapper. */
interface FlatHierarchyNode {
  [key: string]: unknown;
  node?: FlatHierarchyNode[];
  bounds?: { left: number; top: number; right: number; bottom: number };
}

function flatNode(value: unknown): FlatHierarchyNode {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a flat hierarchy node");
  }
  return value as FlatHierarchyNode;
}

function flatRoot(value: unknown): FlatHierarchyNode | FlatHierarchyNode[] {
  if (Array.isArray(value)) {
    value.forEach(flatNode);
    return value as FlatHierarchyNode[];
  }
  return flatNode(value);
}

function flatChildren(value: unknown): FlatHierarchyNode[] {
  const children = flatNode(value).node;
  if (!Array.isArray(children)) {
    throw new Error("Expected child hierarchy nodes");
  }
  return children;
}

function flatChild(value: unknown, index: number): FlatHierarchyNode {
  return flatNode(flatChildren(value)[index]);
}

function writtenObservationNode(data: unknown): Record<string, unknown> {
  return z
    .object({
      viewHierarchy: z.object({ hierarchy: z.object({ node: z.record(z.string(), z.unknown()) }) }),
    })
    .parse(data).viewHierarchy.hierarchy.node;
}

function structuredPayload<T>(response: StructuredToolResponse<T>): T {
  const result = getStructuredPayload<T>(response);
  if (result === undefined) {
    throw new Error("Expected structured tool payload");
  }
  return result;
}

/**
 * Build a minimal ObserveResult whose hierarchy carries trimmable attributes:
 * an empty-string field, a default-false boolean, and a `view-id` that
 * duplicates `resource-id`. sanitizeObserveResult should drop all three.
 */
/**
 * Decode an observation-screenshot resource URI back through the ACTUAL #7000
 * resource template registration, proving the emitted URI is built with the
 * same encoding the resource parses (issue #7018).
 */
function matchObservationScreenshotUri(uri: string): {
  deviceId: string;
  observationId: string;
} {
  registerObservationResources();
  const match = ResourceRegistry.matchTemplate(uri);
  if (!match) {
    throw new Error(`URI did not match the observation screenshot template: ${uri}`);
  }
  expect(match.template.uriTemplate).toBe(OBSERVATION_RESOURCE_URIS.OBSERVATION_SCREENSHOT);
  return {
    deviceId: decodeURIComponent(match.params.deviceId),
    observationId: decodeURIComponent(match.params.observationId),
  };
}

function makeObserveResult(): ObserveResult {
  return {
    updatedAt: 123,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: {
      hierarchy: {
        node: {
          "resource-id": "com.example:id/root",
          "view-id": "com.example:id/root", // duplicate → dropped
          text: "", // empty → dropped
          clickable: "false", // default-false boolean → dropped
          "content-desc": "keep-me",
          node: [
            {
              "resource-id": "com.example:id/child",
              text: "Hello",
              focusable: "false", // dropped
            },
          ],
        },
      },
    },
    elements: {
      clickable: [{ text: "btn" }],
      scrollable: [],
      text: [],
      media: [],
    },
  } as ObserveResult;
}

/** ObserveResult whose root node carries an object-shaped `bounds`. */
function makeObserveResultWithBounds(): ObserveResult {
  return {
    updatedAt: 123,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: {
      hierarchy: {
        node: {
          "resource-id": "com.example:id/root",
          bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
          node: [
            {
              "resource-id": "com.example:id/child",
              bounds: { left: 10, top: 20, right: 30, bottom: 40 },
            },
          ],
        },
      },
    },
  } as ObserveResult;
}

class FakeObservationArtifactWriter implements ObservationArtifactWriter {
  writes: ObservationArtifactWriteInput[] = [];
  throwOnWrite: Error | undefined;

  writeJsonArtifact(input: ObservationArtifactWriteInput) {
    if (this.throwOnWrite) {
      throw this.throwOnWrite;
    }
    this.writes.push(input);
    return {
      artifact: {
        path: `/tmp/auto-mobile/${input.tool}-${this.writes.length}.json`,
        format: "json",
        payload: input.payload,
        bytes: 123,
        tool: input.tool,
        resourceUri: `automobile:tool-output/${input.tool}-${this.writes.length}`,
      },
    };
  }
}

describe("finalizeToolResponse", () => {
  // Bounds compaction and skeleton projection are now unconditional defaults, and
  // `elements` are dropped by default (opt back in via
  // `--observe-result-include-elements`). Only the include-elements accessor
  // survives; save/restore it so a test toggling it can't leak into the singleton.
  let originalIncludeElements: boolean;

  beforeEach(() => {
    originalIncludeElements = serverConfig.isObserveResultIncludeElementsEnabled();
    serverConfig.setObserveResultIncludeElementsEnabled(false);
  });

  afterEach(() => {
    serverConfig.setObserveResultIncludeElementsEnabled(originalIncludeElements);
  });

  test.each(["full", "skeleton"] as const)(
    "all panels use the %s projection and preserve the default top level",
    (project) => {
      const observation = loadAndroidHomeObserve().observe;
      observation.display = { key: "cover", role: "cover", posture: "unknown", generation: 0 };
      observation.deviceId = "android";
      observation.observationId = "capture";
      observation.freshness = { isFresh: true };
      const ordinary = structuredPayload(
        finalizeToolResponse(createStructuredToolResponse(observation), {
          name: "observe",
          args: { project },
        }),
      );
      const entry = {
        display: observation.display,
        screenSize: observation.screenSize,
        freshness: observation.freshness,
        viewHierarchy: observation.viewHierarchy,
        elements: observation.elements,
      };
      const aggregate = {
        ...observation,
        displays: [
          entry,
          { ...entry, display: { ...entry.display, key: "external", role: "external" as const } },
        ],
      };
      const original = JSON.stringify(aggregate);
      const { displays, ...topLevel } = structuredPayload(
        finalizeToolResponse(createStructuredToolResponse(aggregate), {
          name: "observe",
          args: { project, display: "all" },
        }),
      );
      expect(JSON.stringify(topLevel)).toBe(JSON.stringify(ordinary));
      expect(displays).toHaveLength(2);
      expect(displays?.[0].elements).toBeUndefined();
      if (project === "skeleton") {
        expect(displays?.[0].viewHierarchy).toBeUndefined();
        expect(displays?.[0].skeleton).toEqual(ordinary.skeleton);
        expect(displays?.[1].skeleton).toEqual(ordinary.skeleton);
      } else {
        expect(displays?.[0].viewHierarchy).toEqual(ordinary.viewHierarchy);
      }
      expect(JSON.stringify(aggregate)).toBe(original);
    },
  );

  test("each scoped panel uses its own capture metadata", () => {
    const active = loadAndroidHomeObserve().observe;
    const external = {
      ...loadAndroidHomeObserve().observe,
      activeWindow: { ...active.activeWindow!, appId: "external.app" },
      systemInsets: { top: 100, bottom: 200, left: 0, right: 0 },
      insets: undefined,
      display: {
        key: "external",
        role: "external" as const,
        posture: "unknown" as const,
        generation: 0,
      },
      freshness: { isFresh: true },
    };
    const args = { project: "full", scope: { region: true } };
    const expected = structuredPayload(
      finalizeToolResponse(createStructuredToolResponse(external), {
        name: "observe",
        args,
      }),
    );
    const entry = {
      display: external.display,
      screenSize: external.screenSize,
      viewHierarchy: external.viewHierarchy,
      freshness: external.freshness,
      elements: external.elements,
      systemInsets: external.systemInsets,
      insets: external.insets,
      activeWindow: external.activeWindow,
    };
    const aggregate = { ...active, displays: [entry] };
    const output = structuredPayload(
      finalizeToolResponse(createStructuredToolResponse(aggregate), {
        name: "observe",
        args: { ...args, display: "all" },
      }),
    );
    expect(output.displays?.[0].viewHierarchy).toEqual(expected.viewHierarchy);
    expect(output.displays?.[0].observeScope).toEqual(expected.observeScope);
    expect(output.displays?.[0].systemInsets).toBeUndefined();
    expect(output.displays?.[0].activeWindow).toBeUndefined();
  });

  test("windowTruncations follows the skeleton projection into each display entry", () => {
    const active = loadAndroidHomeObserve().observe;
    const external = loadAndroidHomeObserve().observe;
    external.viewHierarchy!.windows![0].truncationReasons = ["max_depth"];
    const finalized = finalizeToolResponse(
      createStructuredToolResponse({
        ...active,
        displays: [active, { ...external, freshness: { isFresh: true } }],
      }),
      { name: "observe", args: { display: "all", project: "skeleton" } },
    );
    const output = structuredPayload(finalized);
    expect(output.displays?.[0].windowTruncations).toBeUndefined();
    expect(output.displays?.[1].windowTruncations).toEqual([
      {
        windowId: external.viewHierarchy!.windows![0].id,
        reasons: ["max_depth"],
      },
    ]);
  });

  test("an oversized all result retains every projected panel in the artifact", () => {
    const observation = loadAndroidHomeObserve().observe;
    observation.observationId = "capture";
    observation.deviceId = "android";
    observation.display = { key: "cover", role: "cover", posture: "unknown", generation: 0 };
    const entry = {
      display: observation.display,
      screenSize: observation.screenSize,
      viewHierarchy: observation.viewHierarchy,
      freshness: { isFresh: true },
    };
    observation.displays = Array.from({ length: 12 }, (_, index) => ({
      ...entry,
      display: { ...entry.display, key: String(index) },
    }));
    const writer = new FakeObservationArtifactWriter();
    const response = finalizeToolResponse(createStructuredToolResponse(observation), {
      name: "observe",
      args: { display: "all", project: "full" },
      artifactWriter: writer,
      artifactMode: "oversized",
    });
    expect(writer.writes).toHaveLength(1);
    const written = writer.writes[0].data as ObserveResult;
    expect(written.displays).toHaveLength(12);
    expect(written.displays?.at(-1)?.display.key).toBe("11");
    expect(written.displays?.[0].viewHierarchy).toEqual(written.viewHierarchy);
    expect(structuredPayload(response)).toHaveProperty("artifact");
    expect(Buffer.byteLength(JSON.stringify(structuredPayload(response)))).toBeLessThan(
      DEFAULT_OBSERVATION_INLINE_MAX_BYTES,
    );
  });

  test("all never replaces the session baseline or rendered display fence", () => {
    const original = serverConfig.isActionsDiffObserveEnabled();
    const writes: string[] = [];
    const store = {
      get: () => undefined,
      set: () => {
        writes.push("baseline");
      },
      setDisplayRevision: () => {
        writes.push("fence");
      },
    };
    const observation = { ...loadAndroidHomeObserve().observe, displayRevision: 9 };
    try {
      for (const diff of [false, true]) {
        serverConfig.setActionsDiffObserveEnabled(diff);
        finalizeToolResponse(createStructuredToolResponse(observation), {
          name: "observe",
          args: { display: "all" },
          sessionUuid: "owner",
          baselineStore: store,
        });
      }
      expect(writes).toEqual([]);
    } finally {
      serverConfig.setActionsDiffObserveEnabled(original);
    }
  });

  test("records only caller-visible observation revisions and strips the internal stamp", () => {
    const originalDiff = serverConfig.isActionsDiffObserveEnabled();
    const originalNoObserve = serverConfig.isActionsNoObserveEnabled();
    let renderedRevision: number | undefined;
    const store = {
      get: () => undefined,
      set: (_sessionUuid: string, _observation: ObserveResult, revision?: number) => {
        renderedRevision = revision;
      },
      setDisplayRevision: (_sessionUuid: string, revision: number) => {
        renderedRevision = revision;
      },
    };
    const stamped = (revision: number) => ({
      ...makeObserveResult(),
      displayRevision: revision,
    });
    try {
      serverConfig.setActionsDiffObserveEnabled(false);
      serverConfig.setActionsNoObserveEnabled(false);
      const initial = finalizeToolResponse(createStructuredToolResponse(stamped(0)), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
        args: { project: "full" },
      });
      expect(renderedRevision).toBe(0);
      expect(structuredPayload(initial).displayRevision).toBeUndefined();

      // An internal setPosture-style observation does not move what the caller saw.
      finalizeToolResponse(createStructuredToolResponse(stamped(1)), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
        internal: true,
      });
      expect(renderedRevision).toBe(0);

      const refreshed = finalizeToolResponse(createStructuredToolResponse(stamped(1)), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
        args: { project: "full" },
      });
      expect(renderedRevision).toBe(1);
      expect(structuredPayload(refreshed).displayRevision).toBeUndefined();
    } finally {
      serverConfig.setActionsDiffObserveEnabled(originalDiff);
      serverConfig.setActionsNoObserveEnabled(originalNoObserve);
    }
  });

  test("EC1: observe response is sanitized in both structuredContent and text", () => {
    const obs = makeObserveResult();
    const response = createStructuredToolResponse(obs);

    // project:"full" opts out of the now-default skeleton so this stays a test of
    // hierarchy trimming.
    const finalized = finalizeToolResponse(response, {
      name: "observe",
      sessionUuid: "s1",
      args: { project: "full" },
    });

    const rootSc = flatNode(
      (structuredPayload(finalized) as ObserveResult).viewHierarchy!.hierarchy.node,
    );
    // Trimmed: duplicate view-id, empty text, default-false clickable all gone.
    expect(rootSc["view-id"]).toBeUndefined();
    expect(rootSc.text).toBeUndefined();
    expect(rootSc.clickable).toBeUndefined();
    // Preserved: content-desc and resource-id.
    expect(rootSc["content-desc"]).toBe("keep-me");
    expect(rootSc["resource-id"]).toBe("com.example:id/root");
    // Child trimmed too.
    expect(rootSc.node[0].focusable).toBeUndefined();
    expect(rootSc.node[0].text).toBe("Hello");

    // EC7: text mirrors the sanitized structuredContent exactly.
    expect(finalized.content[0].text).toBe(stringifyToolResponse(structuredPayload(finalized)));
    const rootText = JSON.parse(finalized.content[0].text).viewHierarchy.hierarchy.node;
    expect(rootText["view-id"]).toBeUndefined();
  });

  test("EC2: action response has its .observation sanitized in both text and structuredContent", () => {
    const obs = makeObserveResult();
    const actionPayload = { success: true, observation: obs };
    const response = createStructuredToolResponse(actionPayload);

    // project:"full" keeps the raw hierarchy under test; the skeleton default is
    // covered separately in "action-tool skeleton default (#5872)".
    const finalized = finalizeToolResponse(response, {
      name: "tapOn",
      sessionUuid: "s1",
      args: { project: "full" },
    });

    const obsSc = structuredPayload(finalized).observation as ObserveResult;
    const rootSc = flatNode(obsSc.viewHierarchy!.hierarchy.node);
    expect(rootSc["view-id"]).toBeUndefined();
    expect(rootSc.clickable).toBeUndefined();
    expect(structuredPayload(finalized).success).toBe(true);

    const parsed = JSON.parse(finalized.content[0].text);
    expect(parsed.observation.viewHierarchy.hierarchy.node["view-id"]).toBeUndefined();
    expect(finalized.content[0].text).toBe(stringifyToolResponse(structuredPayload(finalized)));
  });

  // Action tools default their embedded observation to the compact skeleton
  // (issue #5872): the same response-shape control `observe` already has, so a
  // client no longer pays the full raw hierarchy on every tapOn/sendKeys/launchApp.
  describe("action-tool skeleton default (#5872)", () => {
    test.each([
      { label: "Android physical pixels", load: () => loadAndroidHomeObserve().observe },
      { label: "iOS logical points", load: loadIosFractionalObserve },
    ])(
      "standalone and embedded full/skeleton observations retain the same native geometry (#7336 bullet 1)",
      ({ load }) => {
        const standaloneFull = finalizeToolResponse(createStructuredToolResponse(load()), {
          name: "observe",
          args: { project: "full" },
        }).structuredContent as ObserveResult;
        const embeddedFull = (
          finalizeToolResponse(
            createStructuredToolResponse({ success: true, observation: load() }),
            { name: "tapOn", args: { project: "full" } },
          ).structuredContent as { observation: ObserveResult }
        ).observation;
        const standaloneSkeleton = finalizeToolResponse(createStructuredToolResponse(load()), {
          name: "observe",
          args: { project: "skeleton" },
        }).structuredContent as ObserveResult;
        const embeddedSkeleton = (
          finalizeToolResponse(
            createStructuredToolResponse({ success: true, observation: load() }),
            { name: "tapOn", args: { project: "skeleton" } },
          ).structuredContent as { observation: ObserveResult }
        ).observation;
        const rootBounds = (observation: ObserveResult) => {
          const root = flatRoot(observation.viewHierarchy!.hierarchy.node);
          return (Array.isArray(root) ? root[0] : root).bounds;
        };

        // The action response is an agent-facing observation of the same fixture,
        // never a canonical-pixel reinterpretation of it.
        expect(embeddedFull.screenSize).toEqual(standaloneFull.screenSize);
        expect(rootBounds(embeddedFull)).toEqual(rootBounds(standaloneFull));
        expect(embeddedSkeleton.screenSize).toEqual(standaloneSkeleton.screenSize);
        expect(embeddedSkeleton.skeleton).toEqual(standaloneSkeleton.skeleton);
      },
    );

    test.each(["tapOn", "tapAt"])(
      "%s observation defaults to the compact skeleton (no viewHierarchy)",
      (name) => {
        const response = createStructuredToolResponse({
          success: true,
          observation: makeObserveResult(),
        });
        const finalized = finalizeToolResponse(response, { name });
        const observation = structuredPayload(finalized).observation;
        expect(Array.isArray(observation.skeleton)).toBe(true);
        expect(observation.viewHierarchy).toBeUndefined();
        expect(observation.elements).toBeUndefined();
        // The compact form is under the SAME `skeleton` key `observe` uses (#5872 AC2).
        const parsed = JSON.parse(finalized.content[0].text);
        expect(Array.isArray(parsed.observation.skeleton)).toBe(true);
        expect(parsed.observation.viewHierarchy).toBeUndefined();
        expect(finalized.content[0].text).toBe(stringifyToolResponse(structuredPayload(finalized)));
      },
    );

    test('project:"full" opts an action observation back into the raw viewHierarchy', () => {
      const response = createStructuredToolResponse({
        success: true,
        observation: makeObserveResult(),
      });
      const finalized = finalizeToolResponse(response, {
        name: "tapOn",
        args: { project: "full" },
      });
      const observation = structuredPayload(finalized).observation;
      expect(observation.viewHierarchy).toBeDefined();
      expect(observation.skeleton).toBeUndefined();
    });

    test("raw:true opts an action observation back into the raw viewHierarchy", () => {
      const response = createStructuredToolResponse({
        success: true,
        observation: makeObserveResult(),
      });
      const finalized = finalizeToolResponse(response, {
        name: "sendKeys",
        args: { raw: true, commands: [{ action: "type", text: "hello" }] },
      });
      const observation = structuredPayload(finalized).observation;
      expect(observation.viewHierarchy).toBeDefined();
      expect(observation.skeleton).toBeUndefined();
    });

    test("launchApp's observation also defaults to the compact skeleton", () => {
      const response = createStructuredToolResponse({
        success: true,
        packageName: "com.example",
        observation: makeObserveResult(),
      });
      const finalized = finalizeToolResponse(response, { name: "launchApp" });
      const observation = structuredPayload(finalized).observation;
      expect(Array.isArray(observation.skeleton)).toBe(true);
      expect(observation.viewHierarchy).toBeUndefined();
    });

    test("internal tool-to-tool calls keep the full viewHierarchy for in-process consumers", () => {
      const response = createStructuredToolResponse({
        success: true,
        observation: makeObserveResult(),
      });
      const finalized = finalizeToolResponse(response, { name: "tapOn", internal: true });
      const observation = structuredPayload(finalized).observation;
      expect(observation.viewHierarchy).toBeDefined();
      expect(observation.skeleton).toBeUndefined();
    });

    // Issue #5886: the skeleton default + raw/project opt-out now extends to
    // every observation-producing action tool, not just the original three.
    // swipeOn is the representative extra tool named in the issue's test AC.
    describe("extended to all observation-producing action tools (#5886)", () => {
      test("swipeOn's observation defaults to the compact skeleton", () => {
        const response = createStructuredToolResponse({
          success: true,
          observation: makeObserveResult(),
        });
        const finalized = finalizeToolResponse(response, { name: "swipeOn" });
        const observation = structuredPayload(finalized).observation;
        expect(Array.isArray(observation.skeleton)).toBe(true);
        expect(observation.viewHierarchy).toBeUndefined();
        expect(observation.elements).toBeUndefined();
      });

      test('swipeOn honors project:"full" back into the raw viewHierarchy', () => {
        const response = createStructuredToolResponse({
          success: true,
          observation: makeObserveResult(),
        });
        const finalized = finalizeToolResponse(response, {
          name: "swipeOn",
          args: { project: "full" },
        });
        const observation = structuredPayload(finalized).observation;
        expect(observation.viewHierarchy).toBeDefined();
        expect(observation.skeleton).toBeUndefined();
      });

      test("swipeOn honors raw:true back into the raw viewHierarchy", () => {
        const response = createStructuredToolResponse({
          success: true,
          observation: makeObserveResult(),
        });
        const finalized = finalizeToolResponse(response, {
          name: "swipeOn",
          args: { raw: true },
        });
        const observation = structuredPayload(finalized).observation;
        expect(observation.viewHierarchy).toBeDefined();
        expect(observation.skeleton).toBeUndefined();
      });

      // A representative sample of the newly-covered tools all skeletonize by
      // default (the full roster is bound to the opt-out by the anti-divergence
      // test in test/server/tools/schema.integration.test.ts).
      test.each(["dragAndDrop", "pressButton", "rotate", "homeScreen", "terminateApp"])(
        "%s defaults its observation to the compact skeleton",
        (toolName) => {
          const response = createStructuredToolResponse({
            success: true,
            observation: makeObserveResult(),
          });
          const finalized = finalizeToolResponse(response, { name: toolName });
          const observation = structuredPayload(finalized).observation;
          expect(Array.isArray(observation.skeleton)).toBe(true);
          expect(observation.viewHierarchy).toBeUndefined();
        },
      );
    });

    test("a tool NOT in the skeleton-default set keeps the full hierarchy", () => {
      // The default remains scoped to the advertised set: a tool outside it (here
      // a synthetic name that embeds an observation but never opts in) must NOT be
      // silently skeletonized — the raw tree stays recoverable.
      const response = createStructuredToolResponse({
        success: true,
        observation: makeObserveResult(),
      });
      const finalized = finalizeToolResponse(response, { name: "someUncoveredTool" });
      const observation = structuredPayload(finalized).observation;
      expect(observation.viewHierarchy).toBeDefined();
      expect(observation.skeleton).toBeUndefined();
    });
  });

  // A default `observe` projects to the skeleton, which deletes `viewHierarchy`
  // — the only carrier of the hierarchy's truncation provenance (issue #6601
  // review PRRT_kwDOP-GF5M6h4sDi). The finalized default response must still
  // say the tree was capped, or the agent reads a short list as a complete one.
  test("a default observe response keeps the hierarchy truncation reasons", () => {
    const obs = makeObserveResult();
    obs.viewHierarchy!.truncationReasons = ["max_nodes"];

    const finalized = finalizeToolResponse(createStructuredToolResponse(obs), {
      name: "observe",
    });

    const payload = structuredPayload(finalized) as ObserveResult;
    expect(payload.viewHierarchy).toBeUndefined();
    expect(payload.truncationReasons).toEqual(["max_nodes"]);
    expect(JSON.parse(finalized.content[0].text).truncationReasons).toEqual(["max_nodes"]);
  });

  // Issue #6933: a host-output `max_children[...]` cap trims only the rendered
  // `viewHierarchy` payload — `DefaultObserveElementCollector` (the source of
  // the skeleton's elements) follows the uncapped raw hierarchy under
  // `--raw-element-search` — so the skeleton projection must NOT surface it as
  // if the skeleton itself were an incomplete subset.
  test("a default observe response does not surface a host-output max_children cap as skeleton incompleteness", () => {
    const obs = makeObserveResult();
    obs.viewHierarchy!.truncationReasons = ["max_children[com.example:id/root kept 64 of 70]"];

    const finalized = finalizeToolResponse(createStructuredToolResponse(obs), {
      name: "observe",
    });

    const payload = structuredPayload(finalized) as ObserveResult;
    expect(payload.viewHierarchy).toBeUndefined();
    expect(payload.truncationReasons).toBeUndefined();
  });

  test("EC4: elements are kept only when the include-elements gate is enabled", () => {
    // Elements are dropped by default now; `--observe-result-include-elements`
    // opts back in. project:"full" keeps the headline hierarchy so `elements`
    // is the field under test rather than the skeleton default.
    serverConfig.setObserveResultIncludeElementsEnabled(true);
    const keep = finalizeToolResponse(createStructuredToolResponse(makeObserveResult()), {
      name: "observe",
      args: { project: "full" },
    });
    expect((structuredPayload(keep) as ObserveResult).elements).toBeDefined();

    serverConfig.setObserveResultIncludeElementsEnabled(false);
    const drop = finalizeToolResponse(createStructuredToolResponse(makeObserveResult()), {
      name: "observe",
      args: { project: "full" },
    });
    expect((structuredPayload(drop) as ObserveResult).elements).toBeUndefined();
    expect(JSON.parse(drop.content[0].text).elements).toBeUndefined();
  });

  test("EC6: the caller's in-memory ObserveResult is never mutated", () => {
    const obs = makeObserveResult();
    const response = createStructuredToolResponse(obs);
    // The handler's own result object is the structuredContent reference.
    finalizeToolResponse(response, { name: "observe" });

    // Original object still carries the redundant fields — sanitize is output-only.
    const originalRoot = flatNode(obs.viewHierarchy!.hierarchy.node);
    expect(originalRoot["view-id"]).toBe("com.example:id/root");
    expect(originalRoot.clickable).toBe("false");
    expect(obs.elements).toBeDefined();
  });

  test("EC5: non-observe/non-observation responses pass through unchanged", () => {
    const payload = { success: true, message: "done" };
    const response = createStructuredToolResponse(payload);
    const finalized = finalizeToolResponse(response, { name: "pressButton" });
    expect(structuredPayload(finalized)).toEqual(payload);
    expect(finalized.content[0].text).toBe(stringifyToolResponse(payload));
  });

  test("EC5: image responses (no text part) pass through unchanged", () => {
    const imageResponse: any = {
      content: [{ type: "image", data: "base64==", mimeType: "image/png" }],
    };
    const finalized = finalizeToolResponse(imageResponse, { name: "observe" });
    expect(finalized).toBe(imageResponse);
    expect(finalized.content[0].type).toBe("image");
  });

  test("EC5: non-JSON text-only responses pass through unchanged", () => {
    const textResponse: any = { content: [{ type: "text", text: "not json at all" }] };
    const finalized = finalizeToolResponse(textResponse, { name: "observe" });
    expect(finalized.content[0].text).toBe("not json at all");
  });

  test("EC5: null / primitive responses are returned as-is", () => {
    expect(finalizeToolResponse(null, { name: "observe" })).toBeNull();
    expect(finalizeToolResponse(undefined, { name: "observe" })).toBeUndefined();
    expect(finalizeToolResponse("plain", { name: "observe" })).toBe("plain");
  });

  test("observe payload without a viewHierarchy still strips perfTiming", () => {
    const payload: any = {
      updatedAt: 1,
      screenSize: { width: 1, height: 1 },
      systemInsets: {},
      perfTiming: [{ name: "observe", durationMs: 12 }],
      perfTimingTruncated: true,
    };
    const response = createStructuredToolResponse(payload);

    const finalized = finalizeToolResponse(response, { name: "observe" });

    expect(structuredPayload(finalized).perfTiming).toBeUndefined();
    expect(structuredPayload(finalized).perfTimingTruncated).toBe(true);
    expect(payload.perfTiming).toBeDefined();
    expect(finalized.content[0].text).toBe(stringifyToolResponse(structuredPayload(finalized)));
  });

  test("action observation without a viewHierarchy still strips perfTiming", () => {
    const observation: any = {
      updatedAt: 1,
      screenSize: { width: 1, height: 1 },
      systemInsets: {},
      perfTiming: [{ name: "tapOn", durationMs: 12 }],
    };
    const response = createStructuredToolResponse({ success: true, observation });

    const finalized = finalizeToolResponse(response, { name: "tapOn" });

    expect(structuredPayload(finalized).observation.perfTiming).toBeUndefined();
    expect(observation.perfTiming).toBeDefined();
    expect(finalized.content[0].text).toBe(stringifyToolResponse(structuredPayload(finalized)));
  });

  test("strips the performance-audit raw dumps and truncates diagnostics at the GFXINFO marker", () => {
    const obs = makeObserveResult();
    obs.performanceAudit = {
      metrics: { gfxinfoRaw: "HUGE RAW DUMP", cpuStatsRaw: "CPU RAW", p99: 16 },
      diagnostics: `summary line\n${GFXINFO_DUMP_MARKER}\nmegabytes of raw frame data`,
    };
    const finalized = finalizeToolResponse(createStructuredToolResponse(obs), {
      name: "observe",
      args: { project: "full" },
    });

    const audit = structuredPayload(finalized).performanceAudit;
    expect(audit.metrics.gfxinfoRaw).toBeNull();
    expect(audit.metrics.cpuStatsRaw).toBeNull();
    expect(audit.metrics.p99).toBe(16); // computed metric preserved
    expect(audit.diagnostics).toBe("summary line");
    // Original in-memory audit is untouched (output-only).
    expect(obs.performanceAudit.metrics.gfxinfoRaw).toBe("HUGE RAW DUMP");
  });

  test("preserves the observe-only awaitedElement extras spread into the payload", () => {
    const obs = makeObserveResult();
    const withExtras = {
      ...obs,
      awaitedElement: { text: "Found" },
      awaitDuration: 250,
      awaitTimeout: false,
    };
    const finalized = finalizeToolResponse(createStructuredToolResponse(withExtras), {
      name: "observe",
      args: { project: "full" },
    });

    const sc = structuredPayload(finalized);
    expect(sc.awaitedElement).toEqual({ text: "Found" });
    expect(sc.awaitDuration).toBe(250);
    // Hierarchy still trimmed alongside the preserved extras.
    expect(sc.viewHierarchy.hierarchy.node["view-id"]).toBeUndefined();
  });

  test("drops elements on an action's nested .observation by default", () => {
    const response = createStructuredToolResponse({
      success: true,
      observation: makeObserveResult(),
    });
    const finalized = finalizeToolResponse(response, { name: "tapOn" });
    expect(structuredPayload(finalized).observation.elements).toBeUndefined();
    expect(JSON.parse(finalized.content[0].text).observation.elements).toBeUndefined();
  });

  test("trims an array-shaped root node (both roots)", () => {
    const obs = makeObserveResult();
    obs.viewHierarchy!.hierarchy.node = [
      { "resource-id": "a", "view-id": "a", clickable: "false" },
      { "resource-id": "b", "view-id": "b", focusable: "false" },
    ];
    const finalized = finalizeToolResponse(createStructuredToolResponse(obs), {
      name: "observe",
      args: { project: "full" },
    });
    const roots = structuredPayload(finalized).viewHierarchy.hierarchy.node;
    expect(roots[0]["view-id"]).toBeUndefined();
    expect(roots[0].clickable).toBeUndefined();
    expect(roots[1]["view-id"]).toBeUndefined();
    expect(roots[1].focusable).toBeUndefined();
  });

  test("falls back to content text when structuredContent is absent", () => {
    const obs = makeObserveResult();
    const textOnly: any = { content: [{ type: "text", text: JSON.stringify(obs) }] };
    const finalized = finalizeToolResponse(textOnly, {
      name: "observe",
      args: { project: "full" },
    });
    const root = JSON.parse(finalized.content[0].text).viewHierarchy.hierarchy.node;
    expect(root["view-id"]).toBeUndefined();
    expect(root.clickable).toBeUndefined();
  });

  test("EC-C: compaction flattens node bounds in both structuredContent and text (permanent default)", () => {
    const finalized = finalizeToolResponse(
      createStructuredToolResponse(makeObserveResultWithBounds()),
      { name: "observe", args: { project: "full" } },
    );

    const rootSc = structuredPayload(finalized).viewHierarchy.hierarchy.node;
    expect(rootSc.bounds).toEqual([0, 0, 1080, 1920]);
    expect(rootSc.node[0].bounds).toEqual([10, 20, 30, 40]);

    const rootText = JSON.parse(finalized.content[0].text).viewHierarchy.hierarchy.node;
    expect(rootText.bounds).toEqual([0, 0, 1080, 1920]);
    // Text mirrors structuredContent exactly.
    expect(finalized.content[0].text).toBe(stringifyToolResponse(structuredPayload(finalized)));
  });

  test("EC-C: compaction flattens bounds on an action's nested .observation (tapOn path)", () => {
    const response = createStructuredToolResponse({
      success: true,
      observation: makeObserveResultWithBounds(),
    });
    const finalized = finalizeToolResponse(response, {
      name: "tapOn",
      sessionUuid: "s1",
      args: { project: "full" },
    });

    const obsSc = structuredPayload(finalized).observation;
    expect(obsSc.viewHierarchy.hierarchy.node.bounds).toEqual([0, 0, 1080, 1920]);
    expect(obsSc.viewHierarchy.hierarchy.node.node[0].bounds).toEqual([10, 20, 30, 40]);
    expect(structuredPayload(finalized).success).toBe(true);

    // Text mirrors the sanitized structuredContent exactly on the .observation branch too.
    const parsed = JSON.parse(finalized.content[0].text);
    expect(parsed.observation.viewHierarchy.hierarchy.node.bounds).toEqual([0, 0, 1080, 1920]);
    expect(finalized.content[0].text).toBe(stringifyToolResponse(structuredPayload(finalized)));
  });

  test("EC-C: bounds are always compacted to tuples with no opt-out (permanent default)", () => {
    // Compaction was formerly flag-gated; it is now unconditional, so even with no
    // explicit opt-in the served bounds are the positional tuple, never the object.
    const finalized = finalizeToolResponse(
      createStructuredToolResponse(makeObserveResultWithBounds()),
      { name: "observe", args: { project: "full" } },
    );
    const rootSc = structuredPayload(finalized).viewHierarchy.hierarchy.node;
    expect(Array.isArray(rootSc.bounds)).toBe(true);
    expect(rootSc.bounds).toEqual([0, 0, 1080, 1920]);
  });

  test("EC-C: compaction is output-only — the caller's in-memory bounds object is untouched", () => {
    const obs = makeObserveResultWithBounds();
    finalizeToolResponse(createStructuredToolResponse(obs), { name: "observe" });
    expect(obs.viewHierarchy!.hierarchy.node).not.toBeInstanceOf(Array);
    expect(flatNode(obs.viewHierarchy!.hierarchy.node).bounds).toEqual({
      left: 0,
      top: 0,
      right: 1080,
      bottom: 1920,
    });
  });

  test("EC-C: compaction composes with the default elements-drop and the wire-strip flag", () => {
    // compaction (always on) + elements dropped by default + the wire-strip flag.
    const originalStrip = serverConfig.isToolResultsNoStructuredContentEnabled();
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    try {
      const obs = {
        ...makeObserveResultWithBounds(),
        elements: { clickable: [], scrollable: [], text: [], media: [] },
      };
      const finalized = finalizeToolResponse(createStructuredToolResponse(obs), {
        name: "observe",
        args: { project: "full" },
      });
      const sc = structuredPayload(finalized);
      // finalize keeps structuredContent (the strip is a later wire-boundary concern).
      expect(sc).toBeDefined();
      expect(sc.viewHierarchy.hierarchy.node.bounds).toEqual([0, 0, 1080, 1920]);
      expect(sc.elements).toBeUndefined();
    } finally {
      serverConfig.setToolResultsNoStructuredContentEnabled(originalStrip);
    }
  });

  test("EC-B: finalize never strips structuredContent (that is a wire-boundary concern)", () => {
    // Even with the strip flag on, finalizeToolResponse keeps structuredContent so
    // internal handler callers (e.g. DefaultUIStateSetup's swipeOn found-detection)
    // can still read it — the strip is applied later, only at the MCP boundary.
    const originalStrip = serverConfig.isToolResultsNoStructuredContentEnabled();
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    try {
      const finalized = finalizeToolResponse(createStructuredToolResponse(makeObserveResult()), {
        name: "observe",
      });
      expect(structuredPayload(finalized)).toBeDefined();
    } finally {
      serverConfig.setToolResultsNoStructuredContentEnabled(originalStrip);
    }
  });

  // Composition of --observe-result-compact with --actions-diff-observe (issue #2990).
  // The diff behavior itself shipped in #2761 (see the "actions-diff-observe diff
  // emit" block below): the diff runs *inside* `finalizeToolResponse`, *after*
  // `sanitizeObserveResult`/compaction, and only when a `baselineStore` is injected.
  // These two cases pin the compaction invariants that must survive that — note they
  // pass a `sessionUuid` but NO `baselineStore`, so no diff is produced and the full
  // (compacted) observation is emitted:
  //   1. Enabling the diff flag never disables compaction — compaction is now an
  //      unconditional default, independent of the diff flag.
  //   2. That default holds under the diff flag too: a post-action observation still
  //      carries tuple bounds.
  // The diff-and-compact interaction (a served diff carrying tuple bounds) is covered
  // by "compact on: the emitted diff carries tuple-shaped bounds" in the diff-emit block.
  describe("compact × actions-diff-observe composition (#2990)", () => {
    let originalDiff: boolean;

    beforeEach(() => {
      originalDiff = serverConfig.isActionsDiffObserveEnabled();
    });

    afterEach(() => {
      serverConfig.setActionsDiffObserveEnabled(originalDiff);
    });

    test("EC-D1: compaction still flattens a post-action .observation when the diff flag is also on", () => {
      serverConfig.setActionsDiffObserveEnabled(true);

      const response = createStructuredToolResponse({
        success: true,
        observation: makeObserveResultWithBounds(),
      });
      const finalized = finalizeToolResponse(response, {
        name: "tapOn",
        sessionUuid: "s1",
        args: { project: "full" },
      });

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.viewHierarchy.hierarchy.node.bounds).toEqual([0, 0, 1080, 1920]);
      expect(obsSc.viewHierarchy.hierarchy.node.node[0].bounds).toEqual([10, 20, 30, 40]);
      expect(structuredPayload(finalized).success).toBe(true);

      // Text mirrors the sanitized structuredContent exactly on the diffed .observation branch.
      const parsed = JSON.parse(finalized.content[0].text);
      expect(parsed.observation.viewHierarchy.hierarchy.node.bounds).toEqual([0, 0, 1080, 1920]);
      expect(finalized.content[0].text).toBe(stringifyToolResponse(structuredPayload(finalized)));
    });

    test("EC-D2: the diff flag on still compacts — bounds are the tuple (compaction is unconditional)", () => {
      serverConfig.setActionsDiffObserveEnabled(true);

      const response = createStructuredToolResponse({
        success: true,
        observation: makeObserveResultWithBounds(),
      });
      const finalized = finalizeToolResponse(response, {
        name: "tapOn",
        args: { project: "full" },
      });

      const node = structuredPayload(finalized).observation.viewHierarchy.hierarchy.node;
      expect(Array.isArray(node.bounds)).toBe(true);
      expect(node.bounds).toEqual([0, 0, 1080, 1920]);
    });
  });

  // Diff emit (issue #2761): with `--actions-diff-observe` on AND a baseline
  // store injected, a non-observe action emits a *diff* of its post-action
  // observation instead of the full observation. `observe` always emits full and
  // resets the baseline. Falls back to full when the screen changed, the baseline
  // is missing, or there is no sessionUuid (legacy single-agent path).
  describe("actions-diff-observe diff emit (#2761)", () => {
    let originalDiff: boolean;

    /** Same-screen ObserveResult (app/activity/package all match makeObserveResult). */
    function sameScreenObserve(): ObserveResult {
      return {
        ...makeObserveResult(),
        activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
        viewHierarchy: {
          packageName: "com.example",
          hierarchy: {
            node: {
              "resource-id": "com.example:id/root",
              "content-desc": "keep-me",
              node: [{ "resource-id": "com.example:id/child", text: "Hello" }],
            },
          },
        },
      } as ObserveResult;
    }

    /** In-memory baseline store standing in for the sessionManager cache slot. */
    function makeStore(): {
      store: {
        get: (u: string) => ObserveResult | undefined;
        set: (u: string, o: ObserveResult) => void;
      };
      map: Map<string, ObserveResult>;
    } {
      const map = new Map<string, ObserveResult>();
      return {
        map,
        store: {
          get: (u: string) => map.get(u),
          set: (u: string, o: ObserveResult) => {
            map.set(u, o);
          },
        },
      };
    }

    function expectObservationDiff(
      finalized: { structuredContent?: unknown; content: Array<{ text: string }> },
      expected: Record<string, unknown>,
    ): any {
      const metadata = structuredPayload(finalized).observationDiff;
      expect(metadata).toMatchObject(expected);
      if (!("hint" in expected)) {
        expect(metadata).not.toHaveProperty("hint");
      }
      const parsed = JSON.parse(finalized.content[0].text);
      expect(parsed.observationDiff).toEqual(metadata);
      return metadata;
    }

    function iosScreenObserve(
      key: string,
      confidence: "high" | "medium" | "low" = "high",
    ): ObserveResult {
      return {
        ...sameScreenObserve(),
        activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 0 },
        screenIdentity: {
          platform: "ios",
          source: "heuristic",
          confidence,
          key,
          components: {
            bundleId: "com.apple.reminders",
            navigationTitle: key,
          },
        },
        viewHierarchy: {
          packageName: "com.apple.reminders",
          hierarchy: sameScreenObserve().viewHierarchy!.hierarchy,
        },
      } as ObserveResult;
    }

    function checkedIosScreenObserve(
      key: string,
      confidence: "high" | "medium" | "low" = "high",
    ): ObserveResult {
      const observation = iosScreenObserve(key, confidence);
      flatChild(observation.viewHierarchy!.hierarchy.node, 0).checked = "true";
      return observation;
    }

    function finalizeChangedLowConfidenceAction(
      name: string,
      actionArgs: Record<string, unknown>,
      key = "bundle=com.apple.reminders|focus=Title",
      nextKey = key,
    ): StructuredToolResponse<{ success: boolean; observation: ObserveResult }> {
      const { store } = makeStore();
      const baseline = iosScreenObserve(key, "low");
      finalizeToolResponse(createStructuredToolResponse(baseline), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      return finalizeToolResponse(
        createStructuredToolResponse({
          success: true,
          observation: checkedIosScreenObserve(nextKey, "low"),
        }),
        {
          name,
          args: { ...actionArgs, project: "full" },
          sessionUuid: "s1",
          baselineStore: store,
        },
      );
    }

    beforeEach(() => {
      originalDiff = serverConfig.isActionsDiffObserveEnabled();
      serverConfig.setActionsDiffObserveEnabled(true);
    });

    afterEach(() => {
      serverConfig.setActionsDiffObserveEnabled(originalDiff);
    });

    test("a response that is not delivered never advances the diff baseline or display revision (#10081)", () => {
      const revisions: number[] = [];
      const { store, map } = makeStore();
      const trackedStore = {
        ...store,
        setDisplayRevision: (_uuid: string, revision: number) => {
          revisions.push(revision);
        },
      };
      const tap = () =>
        createStructuredToolResponse({
          success: true,
          observation: { ...sameScreenObserve(), displayRevision: 7 },
        });

      finalizeToolResponse(tap(), {
        name: "tapOn",
        sessionUuid: "s1",
        baselineStore: trackedStore,
        delivered: false,
      });
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s2",
        baselineStore: trackedStore,
        delivered: false,
      });

      expect(map.size).toBe(0);
      expect(revisions).toEqual([]);
      const next = finalizeToolResponse(tap(), {
        name: "tapOn",
        sessionUuid: "s1",
        baselineStore: trackedStore,
      });
      expectObservationDiff(next, { mode: "full", reason: "missing_baseline" });
      expect(map.has("s1")).toBe(true);
    });

    test("the display revision is recorded only for a delivered response (#10081)", () => {
      serverConfig.setActionsDiffObserveEnabled(false);
      const revisions: number[] = [];
      const { store } = makeStore();
      const trackedStore = {
        ...store,
        setDisplayRevision: (_uuid: string, revision: number) => {
          revisions.push(revision);
        },
      };
      const tap = () =>
        createStructuredToolResponse({
          success: true,
          observation: { ...sameScreenObserve(), displayRevision: 7 },
        });

      finalizeToolResponse(tap(), {
        name: "tapOn",
        sessionUuid: "s1",
        baselineStore: trackedStore,
        delivered: false,
      });
      expect(revisions).toEqual([]);
      finalizeToolResponse(tap(), {
        name: "tapOn",
        sessionUuid: "s1",
        baselineStore: trackedStore,
      });
      expect(revisions).toEqual([7]);
    });

    test("flag off leaves the action observation full and never touches the store", () => {
      serverConfig.setActionsDiffObserveEnabled(false);
      const { store, map } = makeStore();
      const response = createStructuredToolResponse({
        success: true,
        observation: sameScreenObserve(),
      });
      const finalized = finalizeToolResponse(response, {
        name: "tapOn",
        sessionUuid: "s1",
        baselineStore: store,
        // project:"full" opts out of the #5872 skeleton default so the "full, not a
        // diff" path under test keeps its raw hierarchy; the diff/store behavior is
        // the actual subject here.
        args: { project: "full" },
      });

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expectObservationDiff(finalized, {
        mode: "full",
        reason: "disabled",
        hint: "Set --actions-diff-observe to receive diffs.",
      });
      expect(map.size).toBe(0);
    });

    test("disabled diff hint stays concise while missing-session guidance is preserved", () => {
      serverConfig.setActionsDiffObserveEnabled(false);
      const { store } = makeStore();
      const disabled = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );
      const hint: string = JSON.parse(disabled.content[0].text).observationDiff.hint;
      expect(hint).toContain("--actions-diff-observe");
      expect(hint.length).toBeLessThan(60);
      expect(hint).not.toContain(";");
      expectObservationDiff(disabled, {
        mode: "full",
        reason: "disabled",
        hint: "Set --actions-diff-observe to receive diffs.",
      });

      serverConfig.setActionsDiffObserveEnabled(true);
      const missingSession = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        { name: "tapOn", baselineStore: store },
      );
      expectObservationDiff(missingSession, {
        mode: "full",
        reason: "missing_session",
        hint: "pass sessionUuid from getAndroid/getApple to receive diffs instead of full observations",
      });
    });

    test("observe emits the full observation and resets the baseline", () => {
      const { store, map } = makeStore();
      const finalized = finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
        // project:"full" so the SERVED observe payload keeps its viewHierarchy; the
        // diff baseline is the full sanitized tree regardless of projection.
        args: { project: "full" },
      });

      // Full observation emitted (not a diff).
      expect(structuredPayload(finalized).isDiff).toBeUndefined();
      expect(structuredPayload(finalized).viewHierarchy).toBeDefined();
      // Baseline reset to the sanitized observation.
      expect(map.get("s1")).toBeDefined();
      expect(map.get("s1")!.viewHierarchy).toBeDefined();
    });

    test("a non-observe action emits a diff vs the baseline in both representations", () => {
      const { store } = makeStore();
      // Seed the baseline via an observe.
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      // Next action toggles a child's `checked` on the same screen.
      const next = sameScreenObserve();
      flatChild(next.viewHierarchy!.hierarchy.node, 0).checked = "true";
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, args: { project: "full" } },
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.viewHierarchy).toBeUndefined();
      expect(obsSc.changed).toHaveLength(1);
      expect(obsSc.changed[0].changes.checked).toEqual({ from: undefined, to: "true" });
      expect(structuredPayload(finalized).success).toBe(true);
      expectObservationDiff(finalized, { mode: "diff", reason: "diff_emitted" });

      // Text mirrors the diffed structuredContent exactly.
      const parsed = JSON.parse(finalized.content[0].text);
      expect(parsed.observation.isDiff).toBe(true);
      expect(finalized.content[0].text).toBe(stringifyToolResponse(structuredPayload(finalized)));
    });

    test("a diffed observation ALWAYS carries a usable `skeleton` alongside it (issue #6221 item 4.1)", () => {
      const { store } = makeStore();
      /** Same-screen observation whose `elements` block yields a non-empty skeleton. */
      const withSkeletonElements = (): ObserveResult => ({
        ...sameScreenObserve(),
        elements: {
          clickable: [
            {
              bounds: { left: 0, top: 0, right: 100, bottom: 50 },
              "resource-id": "com.example:id/btn",
              text: "Submit",
              clickable: "true",
            },
          ],
          scrollable: [],
          text: [],
          media: [],
        },
      });

      finalizeToolResponse(createStructuredToolResponse(withSkeletonElements()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = withSkeletonElements();
      flatChild(next.viewHierarchy!.hierarchy.node, 0).checked = "true";
      // Default projection (no `project`/`raw` arg) — the case the issue's dogfood
      // repro hit: a diff response with no skeleton to act on.
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBe(true);
      // The diff is real (a change happened)...
      expect(obsSc.changed).toHaveLength(1);
      // ...AND it still carries a full, usable actionable-only skeleton — never
      // absent just because a diff was emitted.
      expect(Array.isArray(obsSc.skeleton)).toBe(true);
      expect(obsSc.skeleton.length).toBeGreaterThan(0);
      expect(obsSc.skeleton[0].elementId).toBe("com.example:id/btn");
      expect(obsSc.skeleton[0].affordances).toContain("tap");

      // Text mirror agrees.
      const parsed = JSON.parse(finalized.content[0].text);
      expect(parsed.observation.skeleton.length).toBe(obsSc.skeleton.length);
    });

    test("a diffed observation carries `activeWindow` and `freshness` with the same shape as full mode (issue #6258)", () => {
      const { store } = makeStore();
      const freshness = {
        actualTimestamp: 1000,
        ageMs: 5,
        isFresh: true,
      };
      const withFreshness = (): ObserveResult => ({
        ...sameScreenObserve(),
        freshness,
      });

      finalizeToolResponse(createStructuredToolResponse(withFreshness()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = withFreshness();
      flatChild(next.viewHierarchy!.hierarchy.node, 0).checked = "true";
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBe(true);
      // Same shape/name a full-mode observation carries these fields under.
      expect(obsSc.activeWindow).toEqual(next.activeWindow);
      expect(obsSc.freshness).toEqual(freshness);

      // Text mirror agrees.
      const parsed = JSON.parse(finalized.content[0].text);
      expect(parsed.observation.activeWindow).toEqual(obsSc.activeWindow);
      expect(parsed.observation.freshness).toEqual(obsSc.freshness);
    });

    test("a diffed action observation carries its observationId resource join key", () => {
      const { store } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = { ...sameScreenObserve(), observationId: "post-action-observation" };
      flatChild(next.viewHierarchy!.hierarchy.node, 0).checked = "true";
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );

      const observation = structuredPayload(finalized).observation;
      expect(observation.isDiff).toBe(true);
      expect(observation.observationId).toBe(next.observationId);
      expect(JSON.parse(finalized.content[0].text).observation.observationId).toBe(
        next.observationId,
      );
    });

    test("a full observe output surfaces the resolved deviceId and screenshot resource URI (issue #7018)", () => {
      const observe = {
        ...sameScreenObserve(),
        observationId: "observe-abc",
        deviceId: "emulator-5554",
        screenshotCaptureAttempted: true,
      };
      const finalized = finalizeToolResponse(createStructuredToolResponse(observe), {
        name: "observe",
      });

      const sc = structuredPayload(finalized);
      expect(sc.deviceId).toBe("emulator-5554");
      expect(sc.observationScreenshotResourceUri).toBe(
        buildObservationScreenshotUri("emulator-5554", "observe-abc"),
      );
      // The URI is built via the shared template encoder and round-trips back to
      // the #7000 observation-screenshot resource with the same identities.
      expect(matchObservationScreenshotUri(sc.observationScreenshotResourceUri)).toEqual({
        deviceId: "emulator-5554",
        observationId: "observe-abc",
      });
      // Text mirror agrees.
      expect(JSON.parse(finalized.content[0].text).observationScreenshotResourceUri).toBe(
        sc.observationScreenshotResourceUri,
      );
      expect(sc.screenshotCaptureAttempted).toBeUndefined();
      expect(JSON.parse(finalized.content[0].text).screenshotCaptureAttempted).toBeUndefined();
    });

    test("a skip-screenshot waitFor-style observation omits the dangling screenshot URI", () => {
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({
          ...sameScreenObserve(),
          observationId: "wait-for-no-screenshot",
          deviceId: "emulator-5554",
          screenshotCaptureAttempted: false,
          matched: true,
          polls: 1,
        } as ObserveResult & { screenshotCaptureAttempted: boolean }),
        { name: "observe" },
      );

      const observation = structuredPayload(finalized) as Record<string, unknown>;
      expect(observation.observationScreenshotResourceUri).toBeUndefined();
      expect(observation.screenshotCaptureAttempted).toBeUndefined();
      const textObservation = JSON.parse(finalized.content[0].text) as Record<string, unknown>;
      expect(textObservation.observationScreenshotResourceUri).toBeUndefined();
      expect(textObservation.screenshotCaptureAttempted).toBeUndefined();
    });

    test("a diffed action observation carries the deviceId + screenshot resource URI (issue #7018)", () => {
      const { store } = makeStore();
      finalizeToolResponse(
        createStructuredToolResponse({ ...sameScreenObserve(), deviceId: "emulator-5554" }),
        { name: "observe", sessionUuid: "s1", baselineStore: store },
      );

      const next = {
        ...sameScreenObserve(),
        observationId: "post-action-observation",
        deviceId: "emulator-5554",
        screenshotCaptureAttempted: true,
      };
      flatChild(next.viewHierarchy!.hierarchy.node, 0).checked = "true";
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );

      const observation = structuredPayload(finalized).observation;
      expect(observation.isDiff).toBe(true);
      expect(observation.deviceId).toBe("emulator-5554");
      expect(observation.observationScreenshotResourceUri).toBe(
        buildObservationScreenshotUri("emulator-5554", "post-action-observation"),
      );
      expect(matchObservationScreenshotUri(observation.observationScreenshotResourceUri)).toEqual({
        deviceId: "emulator-5554",
        observationId: "post-action-observation",
      });
      expect(
        JSON.parse(finalized.content[0].text).observation.observationScreenshotResourceUri,
      ).toBe(observation.observationScreenshotResourceUri);
      expect(observation.screenshotCaptureAttempted).toBeUndefined();
      expect(
        JSON.parse(finalized.content[0].text).observation.screenshotCaptureAttempted,
      ).toBeUndefined();
    });

    test("an adopted async action screenshot URI joins the adopted capture's stored evidence", async () => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const screenshots = new FakeScreenshotStateStore(timer);
      const action = {
        ...sameScreenObserve(),
        deviceId: "async-device",
        observationId: "action-capture",
        screenshotCaptureAttempted: true,
      };
      const fake = new FakeObserveScreen();
      let cached = action;
      const reads = spyOn(fake, "execute").mockImplementation(async (options) => {
        // Same cached timestamp unless the gate requests a fresh extraction.
        if (options?.requireFreshExtraction) {
          const timestamp = Number(cached.updatedAt) + 1;
          cached = {
            ...action,
            updatedAt: timestamp,
            viewHierarchy: { ...action.viewHierarchy!, updatedAt: timestamp },
            observationId: `adopted-${timestamp}`,
            screenshotCaptureAttempted: false,
          };
        }
        return cached;
      });
      const capture = spyOn(fake, "captureScreenshot").mockImplementation(
        async (_perf, _signal, observation) => {
          if (!observation) {
            throw new Error("Expected the adopted observation");
          }
          observation.screenshotCaptureAttempted = true;
          screenshots.updateForObservation(
            observation.deviceId,
            observation.observationId,
            "/fake/adopted.png",
          );
        },
      );
      try {
        const response = createStructuredToolResponse({ success: true, observation: action });
        await settleEmbeddedObservationInResponse(response, {
          name: "tapOn",
          internal: false,
          createSettleObserve: () => new RealSettleObserve(fake, timer),
        });
        const adopted = response.structuredContent!.observation;
        expect(adopted.screenshotCaptureAttempted).toBe(true);
        expect(capture).toHaveBeenCalledTimes(1);
        expect(capture.mock.calls[0][2]?.observationId).toBe(adopted.observationId);
        expect(reads.mock.calls.every(([options]) => options?.skipScreenshot === true)).toBe(true);
        const finalized = finalizeToolResponse(response, { name: "tapOn" });
        const emitted = structuredPayload(finalized).observation;
        expect(emitted.observationScreenshotResourceUri).toBe(
          buildObservationScreenshotUri(action.deviceId, adopted.observationId),
        );
        expect(matchObservationScreenshotUri(emitted.observationScreenshotResourceUri)).toEqual({
          deviceId: action.deviceId,
          observationId: adopted.observationId,
        });
        expect(screenshots.getPathForObservation(action.deviceId, adopted.observationId)).toBe(
          "/fake/adopted.png",
        );
        expect(
          screenshots.getPathForObservation(action.deviceId, action.observationId),
        ).toBeUndefined();
        expect(
          JSON.parse(finalized.content[0].text).observation.observationScreenshotResourceUri,
        ).toBe(emitted.observationScreenshotResourceUri);
      } finally {
        reads.mockRestore();
        capture.mockRestore();
      }
    });

    test("a skip-screenshot post-action observation omits the dangling screenshot URI", () => {
      const { store } = makeStore();
      finalizeToolResponse(
        createStructuredToolResponse({ ...sameScreenObserve(), deviceId: "emulator-5554" }),
        { name: "observe", sessionUuid: "s1", baselineStore: store },
      );

      const next = {
        ...sameScreenObserve(),
        observationId: "post-action-no-screenshot",
        deviceId: "emulator-5554",
        screenshotCaptureAttempted: false,
      } as ObserveResult & { screenshotCaptureAttempted: boolean };
      flatChild(next.viewHierarchy!.hierarchy.node, 0).checked = "true";
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );

      const observation = structuredPayload(finalized).observation;
      expect(observation.isDiff).toBe(true);
      expect(observation.observationScreenshotResourceUri).toBeUndefined();
      expect(observation.screenshotCaptureAttempted).toBeUndefined();
      const textObservation = JSON.parse(finalized.content[0].text).observation;
      expect(textObservation.observationScreenshotResourceUri).toBeUndefined();
      expect(textObservation.screenshotCaptureAttempted).toBeUndefined();
    });

    test("a diffed observation carries `accessibilityAuditSkipped` with the same shape as full mode (issue #6926)", () => {
      const { store } = makeStore();
      const withAccessibilityAuditSkipped = (): ObserveResult => ({
        ...sameScreenObserve(),
        accessibilityAuditSkipped: "settled_capture_adopted",
      });

      finalizeToolResponse(createStructuredToolResponse(withAccessibilityAuditSkipped()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = withAccessibilityAuditSkipped();
      flatChild(next.viewHierarchy!.hierarchy.node, 0).checked = "true";
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.accessibilityAuditSkipped).toBe("settled_capture_adopted");
      expect(JSON.parse(finalized.content[0].text).observation.accessibilityAuditSkipped).toBe(
        "settled_capture_adopted",
      );
    });

    test("a diffed observation carries every whitelisted passthrough metadata field", () => {
      const { store } = makeStore();
      const freshness = { actualTimestamp: 1000, ageMs: 5, isFresh: true };
      const withPassthroughMetadata = (): ObserveResult => ({
        ...sameScreenObserve(),
        observationId: "passthrough-observation",
        deviceId: "emulator-5554",
        display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
        freshness,
        screenshotSettled: true,
        screenshotSettledError: "Settled screenshot capture timed out",
        screenshotOrientation: "display",
        screenshotImageSize: { width: 1080, height: 2400 },
        screenshotPixelsPerNativeUnit: { x: 1, y: 1 },
        screenshotScaleProvenance: "raster-dimensions",
        screenshotPath: "/data/local/tmp/auto-mobile/screens/passthrough-observation.png",
        screenshotSource: "fresh",
        screenshotCaptureSource: "device",
        screenshotExpiresAt: 600_000,
        screenshotCapturedAt: "1970-01-01T00:00:08.000Z",
        screenshotAgeMs: 2_000,
        screenshotFreshFailure: {
          code: "SCREENSHOT_CAPTURE_FAILED",
          message: "previous capture failed",
          retryable: true,
        },
        screenshotFormat: "png",
        screenshotMimeType: "image/png",
        settled: true,
        accessibilityAuditSkipped: "settled_capture_adopted",
      });

      finalizeToolResponse(createStructuredToolResponse(withPassthroughMetadata()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = withPassthroughMetadata();
      flatChild(next.viewHierarchy!.hierarchy.node, 0).checked = "true";
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );

      const obsSc = structuredPayload(finalized).observation as ObserveResult;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc).toMatchObject({
        screenshotImageSize: next.screenshotImageSize,
        screenshotPixelsPerNativeUnit: next.screenshotPixelsPerNativeUnit,
        screenshotScaleProvenance: next.screenshotScaleProvenance,
      });
      for (const field of DIFF_PASSTHROUGH_METADATA_FIELDS) {
        expect(obsSc[field]).toBeDefined();
        expect(obsSc[field]).toEqual(next[field]);
      }
    });

    test("full and diff action observations retain native iOS point geometry (#7335)", () => {
      const { store } = makeStore();
      const baseline = loadIosFractionalObserve();
      baseline.activeWindow = {
        appId: "com.apple.reminders",
        activityName: "",
        layoutSeqSum: 0,
      };

      const full = finalizeToolResponse(createStructuredToolResponse(baseline), {
        name: "observe",
        args: { project: "full" },
        sessionUuid: "s1",
        baselineStore: store,
      });
      const fullObservation = structuredPayload(full) as ObserveResult;
      const fullRoot = flatNode(fullObservation.viewHierarchy!.hierarchy.node);
      expect(fullObservation.screenSize).toEqual({ width: 393, height: 852 });
      expect(fullRoot.bounds).toEqual([0, 0, 393, 852]);

      const next = loadIosFractionalObserve();
      next.activeWindow = baseline.activeWindow;
      (flatChild(next.viewHierarchy!.hierarchy.node, 0) as Record<string, unknown>).text =
        "Changed title";
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );

      const diff = structuredPayload(finalized).observation;
      expect(diff.isDiff).toBe(true);
      expect(diff.screenSize).toEqual({ width: 393, height: 852 });
      expect(JSON.parse(finalized.content[0].text).observation.screenSize).toEqual(diff.screenSize);
    });

    test.each([
      { label: "Android physical pixels", load: () => loadAndroidHomeObserve().observe },
      { label: "iOS logical points", load: loadIosFractionalObserve },
    ])(
      "embedded diffs retain the standalone fixture screenSize and root bounds (#7336 bullet 1)",
      ({ load }) => {
        const { store } = makeStore();
        const baseline = load();
        baseline.activeWindow = {
          appId: "com.example.coordinate-parity",
          activityName: "",
          layoutSeqSum: 0,
        };
        const standaloneFull = finalizeToolResponse(createStructuredToolResponse(baseline), {
          name: "observe",
          args: { project: "full" },
          sessionUuid: "s1",
          baselineStore: store,
        }).structuredContent as ObserveResult;
        const next = load();
        next.activeWindow = baseline.activeWindow;
        const root = flatRoot(next.viewHierarchy!.hierarchy.node);
        (Array.isArray(root) ? root[0] : root)["content-desc"] = "changed";

        const finalized = finalizeToolResponse(
          createStructuredToolResponse({ success: true, observation: next }),
          { name: "tapOn", sessionUuid: "s1", baselineStore: store },
        );
        const diff = structuredPayload(finalized).observation;
        const standaloneRoot = flatRoot(standaloneFull.viewHierarchy!.hierarchy.node);
        const standaloneBounds = (
          Array.isArray(standaloneRoot) ? standaloneRoot[0] : standaloneRoot
        ).bounds as number[];

        expect(diff.isDiff).toBe(true);
        expect(diff.screenSize).toEqual(standaloneFull.screenSize);
        // Diff identity keys retain the compacted native root bounds verbatim.
        expect(diff.changed[0].key).toContain(`\0${standaloneBounds.join(",")}\0`);
      },
    );

    // A diff REPLACES the projected observation, so the truncation provenance
    // the skeleton projection lifts to the top level (issue #6601) is dropped
    // with it — review thread PRRT_kwDOP-GF5M6h4v0N on PR #6912. The agent then
    // reads a capped skeleton as a complete one.
    test("a diffed observation carries the hierarchy truncation reasons (issue #6601)", () => {
      const { store } = makeStore();
      const reasons = ["max_children[com.example:id/root kept 64 of 70]"];
      const capped = (): ObserveResult => {
        const observation = sameScreenObserve();
        observation.viewHierarchy!.truncationReasons = [...reasons];
        return observation;
      };

      finalizeToolResponse(createStructuredToolResponse(capped()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = capped();
      flatChild(next.viewHierarchy!.hierarchy.node, 0).checked = "true";
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.truncationReasons).toEqual(reasons);

      // Text mirror agrees.
      const parsed = JSON.parse(finalized.content[0].text);
      expect(parsed.observation.truncationReasons).toEqual(reasons);
    });

    test("a diffed observation retains raw host-output truncation alongside served capture-fidelity reasons (issue #6933)", () => {
      const { store } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = sameScreenObserve();
      const reasons = ["max_nodes", "max_children[com.example:id/root kept 64 of 70]"];
      next.viewHierarchy!.truncationReasons = [...reasons];
      flatChild(next.viewHierarchy!.hierarchy.node, 0).checked = "true";
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );

      const observation = structuredPayload(finalized).observation;
      expect(observation.isDiff).toBe(true);
      expect(observation.truncationReasons).toEqual(expect.arrayContaining(reasons));
      expect(observation.truncationReasons).toHaveLength(reasons.length);
    });

    test("a diffed observation under project:'full' still carries the truncation reasons (issue #6601)", () => {
      const { store } = makeStore();
      const reasons = ["max_nodes"];
      const capped = (): ObserveResult => {
        const observation = sameScreenObserve();
        observation.viewHierarchy!.truncationReasons = [...reasons];
        return observation;
      };

      finalizeToolResponse(createStructuredToolResponse(capped()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = capped();
      flatChild(next.viewHierarchy!.hierarchy.node, 0).checked = "true";
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, args: { project: "full" } },
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.truncationReasons).toEqual(reasons);
    });

    test("a diffed observation of an untruncated hierarchy carries no truncationReasons", () => {
      const { store } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = sameScreenObserve();
      flatChild(next.viewHierarchy!.hierarchy.node, 0).checked = "true";
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.truncationReasons).toBeUndefined();
      expect("truncationReasons" in JSON.parse(finalized.content[0].text).observation).toBe(false);
    });

    test.each([{ project: "skeleton" }, { project: "full" }, { raw: true }])(
      "windowTruncations on a diff describes only the current capture (%j)",
      (args) => {
        const { store } = makeStore();
        const baseline = loadAndroidHomeObserve().observe;
        baseline.viewHierarchy!.windows![0].truncationReasons = ["cancelled"];
        finalizeToolResponse(createStructuredToolResponse(baseline), {
          name: "observe",
          sessionUuid: "s1",
          baselineStore: store,
        });
        const next = loadAndroidHomeObserve().observe;
        next.viewHierarchy!.windows![1].truncationReasons = ["max_nodes"];
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({ success: true, observation: next }),
          { name: "tapOn", sessionUuid: "s1", baselineStore: store, args },
        );
        const diff = structuredPayload(finalized).observation;
        expect(diff.isDiff).toBe(true);
        expect(diff.windowTruncations).toEqual([
          {
            windowId: next.viewHierarchy!.windows![1].id,
            reasons: ["max_nodes"],
          },
        ]);
        expect(JSON.parse(finalized.content[0].text).observation.windowTruncations).toEqual(
          diff.windowTruncations,
        );
        const complete = finalizeToolResponse(
          createStructuredToolResponse({
            success: true,
            observation: loadAndroidHomeObserve().observe,
          }),
          { name: "tapOn", sessionUuid: "s1", baselineStore: store, args },
        );
        expect(structuredPayload(complete).observation.isDiff).toBe(true);
        expect("windowTruncations" in structuredPayload(complete).observation).toBe(false);
        expect("windowTruncations" in JSON.parse(complete.content[0].text).observation).toBe(false);
      },
    );

    // Issue #6933: the opposite transition from the #6601 thread above. The
    // BASELINE observation (stored capped, first 64 of 70 rows) carries the
    // truncation reason; the post-action observation this resolver consults
    // has since fallen below the cap and carries none. Without folding the
    // baseline's provenance in, a diff reports a plain removal count with no
    // warning that the "removed" rows past its own cap were never diffable to
    // begin with.
    test("a diffed observation carries the BASELINE's truncation reasons when the current hierarchy fell below the cap (issue #6933)", () => {
      const { store } = makeStore();
      const reasons = ["max_children[com.example:id/root kept 64 of 70]"];
      const cappedBaseline = (): ObserveResult => {
        const observation = sameScreenObserve();
        observation.viewHierarchy!.truncationReasons = [...reasons];
        return observation;
      };

      finalizeToolResponse(createStructuredToolResponse(cappedBaseline()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      // The post-action observation is untruncated (no truncationReasons of its own).
      const next = sameScreenObserve();
      flatChild(next.viewHierarchy!.hierarchy.node, 0).checked = "true";
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.truncationReasons).toEqual(reasons);

      const parsed = JSON.parse(finalized.content[0].text);
      expect(parsed.observation.truncationReasons).toEqual(reasons);
    });

    test("a diffed observation carries a usable `skeleton` even under raw:true / project:'full' (PR #6242 review PRRT_kwDOP-GF5M6fq3iK)", () => {
      const { store } = makeStore();
      const withSkeletonElements = (): ObserveResult => ({
        ...sameScreenObserve(),
        elements: {
          clickable: [
            {
              bounds: { left: 0, top: 0, right: 100, bottom: 50 },
              "resource-id": "com.example:id/btn",
              text: "Submit",
              clickable: "true",
            },
          ],
          scrollable: [],
          text: [],
          media: [],
        },
      });

      finalizeToolResponse(createStructuredToolResponse(withSkeletonElements()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = withSkeletonElements();
      flatChild(next.viewHierarchy!.hierarchy.node, 0).checked = "true";
      // `project: "full"` — servedObservation itself carries NO skeleton in this
      // mode (it is the raw sanitized tree), so the diff must re-project one
      // independently rather than emitting `skeleton: []`.
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, args: { project: "full" } },
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.viewHierarchy).toBeUndefined();
      expect(Array.isArray(obsSc.skeleton)).toBe(true);
      expect(obsSc.skeleton.length).toBeGreaterThan(0);
      expect(obsSc.skeleton[0].elementId).toBe("com.example:id/btn");
    });

    test("a diffed observation ALSO carries the state-readout `context` alongside `skeleton` (issue #6256)", () => {
      const { store } = makeStore();
      // A zero-affordance readout (e.g. a timer countdown) plus one actionable
      // button — the shape `--actions-diff-observe` must not silently drop the
      // readout from, the same way #6221 item 4.1 already guarantees `skeleton`.
      const withReadout = (readoutText: string): ObserveResult => ({
        ...sameScreenObserve(),
        elements: {
          clickable: [
            {
              bounds: { left: 0, top: 0, right: 100, bottom: 50 },
              "resource-id": "com.example:id/btn",
              text: "Start",
              clickable: "true",
            },
          ],
          scrollable: [],
          text: [
            {
              bounds: { left: 0, top: 60, right: 100, bottom: 90 },
              "resource-id": "com.example:id/countdown",
              text: readoutText,
            },
          ],
          media: [],
        },
      });

      finalizeToolResponse(createStructuredToolResponse(withReadout("00h 20m 00s")), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      // A tap changes the hierarchy (so a real diff is emitted) AND the readout's
      // own text updates — the exact failed-vs-successful-input distinction the
      // client needs to make.
      const next = withReadout("00h 19m 59s");
      flatChild(next.viewHierarchy!.hierarchy.node, 0).checked = "true";
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.changed).toHaveLength(1);
      expect(Array.isArray(obsSc.context)).toBe(true);
      expect(obsSc.context).toHaveLength(1);
      expect(obsSc.context[0]).toMatchObject({
        elementId: "com.example:id/countdown",
        label: "00h 19m 59s",
        affordances: [],
      });

      // Text mirror agrees.
      const parsed = JSON.parse(finalized.content[0].text);
      expect(parsed.observation.context).toEqual(obsSc.context);
    });

    test.each(["skeleton", "full"] as const)(
      "%s diffs preserve the keyboard projection contract",
      (project) => {
        const { store } = makeStore();
        finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
          name: "observe",
          sessionUuid: "s1",
          baselineStore: store,
        });
        const next = sameScreenObserve();
        flatChild(next.viewHierarchy!.hierarchy.node, 0).checked = "true";
        const key = {
          text: "Q",
          clickable: true,
          bounds: { left: 0, top: 100, right: 50, bottom: 150 },
        };
        setElementProvenance(key, {
          group: 1,
          enter: 1,
          exit: 1,
          keyboardPackage: "example.keyboard",
        });
        next.elements = { clickable: [key], text: [key], scrollable: [], media: [] };
        flatChildren(next.viewHierarchy!.hierarchy.node).push({
          extras: { "automobile:imePackage": "example.keyboard" },
          node: [key],
        });
        const result = finalizeToolResponse(
          createStructuredToolResponse({ success: true, observation: next }),
          {
            name: "tapOn",
            args: { project },
            sessionUuid: "s1",
            baselineStore: store,
          },
        );
        const observation = structuredPayload(result).observation;
        expect(observation.isDiff).toBe(true);
        expect(observation.keyboard).toEqual({ visible: true, package: "example.keyboard" });
        // The keyboard survives as exactly ONE row, never a key per cap (issue #6871).
        expect(observation.skeleton).toEqual([
          {
            elementId: "<ime>",
            label: "Keyboard (example.keyboard)",
            bounds: [0, 100, 50, 150],
            affordances: ["input"],
          },
        ]);
        expect(observation.added.some((entry: any) => entry.attributes.text === "Q")).toBe(
          project === "full",
        );
        expect(JSON.parse(result.content[0].text).observation.keyboard).toEqual(
          observation.keyboard,
        );
      },
    );

    test("a diff with no surviving readout row omits `context` entirely rather than emitting `[]`", () => {
      const { store } = makeStore();
      const withSkeletonElements = (): ObserveResult => ({
        ...sameScreenObserve(),
        elements: {
          clickable: [
            {
              bounds: { left: 0, top: 0, right: 100, bottom: 50 },
              "resource-id": "com.example:id/btn",
              text: "Submit",
              clickable: "true",
            },
          ],
          scrollable: [],
          text: [],
          media: [],
        },
      });

      finalizeToolResponse(createStructuredToolResponse(withSkeletonElements()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = withSkeletonElements();
      flatChild(next.viewHierarchy!.hierarchy.node, 0).checked = "true";
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.context).toBeUndefined();
    });

    test("returns a full observation when a reported screen change would emit an empty diff", () => {
      const { store } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({
          success: true,
          effect: { screenChanged: true, basis: "viewHierarchy changed" },
          observation: sameScreenObserve(),
        }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, args: { project: "full" } },
      );

      const observation = structuredPayload(finalized).observation;
      expect(observation.isDiff).toBeUndefined();
      expect(observation.viewHierarchy).toBeDefined();
      expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
    });

    test("hierarchy-less action observations emit full sanitized payloads, not empty diffs", () => {
      const { store, map } = makeStore();
      const baseline = sameScreenObserve();
      finalizeToolResponse(createStructuredToolResponse(baseline), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const hierarchyLess = (durationMs: number): ObserveResult => ({
        updatedAt: durationMs,
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        freshness: { isFresh: true },
        errors: [{ phase: "viewHierarchy", message: "service unavailable" }],
        perfTiming: [{ name: "observe", durationMs }],
      });

      const first = finalizeToolResponse(
        createStructuredToolResponse({ success: false, observation: hierarchyLess(12) }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, args: { project: "full" } },
      );
      const second = finalizeToolResponse(
        createStructuredToolResponse({ success: false, observation: hierarchyLess(13) }),
        {
          name: "tapOn",
          sessionUuid: "s1",
          baselineStore: store,
          args: { project: "full" },
        },
      );

      const firstObs = structuredPayload(first).observation;
      const secondObs = structuredPayload(second).observation;
      expect(firstObs.isDiff).toBeUndefined();
      expect(secondObs.isDiff).toBeUndefined();
      expectObservationDiff(first, { mode: "full", reason: "unrenderable_hierarchy" });
      expectObservationDiff(second, { mode: "full", reason: "unrenderable_hierarchy" });
      expect(firstObs.errors[0].message).toBe("service unavailable");
      expect(secondObs.errors[0].message).toBe("service unavailable");
      expect(firstObs.perfTiming).toBeUndefined();
      expect(secondObs.perfTiming).toBeUndefined();
      expect(map.get("s1")).toBeDefined();
      expect(map.get("s1")!.viewHierarchy).toBeDefined();
      expect(first.content[0].text).toBe(stringifyToolResponse(structuredPayload(first)));
      expect(second.content[0].text).toBe(stringifyToolResponse(structuredPayload(second)));
    });

    test("falls back to full when the stored baseline has no renderable hierarchy", () => {
      const { store, map } = makeStore();
      map.set("s1", {
        updatedAt: 1,
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
        viewHierarchy: { packageName: "com.example" },
      } as ObserveResult);

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        {
          name: "tapOn",
          sessionUuid: "s1",
          baselineStore: store,
          args: { project: "full" },
        },
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      const metadata = expectObservationDiff(finalized, {
        mode: "full",
        reason: "unrenderable_hierarchy",
      });
      expect(metadata.fromScreen.activeWindow.appId).toBe("com.example");
      expect(metadata.toScreen.activeWindow.appId).toBe("com.example");
      expect(map.get("s1")!.viewHierarchy?.hierarchy).toBeDefined();
    });

    test("a non-observe action updates the baseline to its own observation (next diff is against current state)", () => {
      const { store, map } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = sameScreenObserve();
      flatChild(next.viewHierarchy!.hierarchy.node, 0).checked = "true";
      finalizeToolResponse(createStructuredToolResponse({ success: true, observation: next }), {
        name: "tapOn",
        sessionUuid: "s1",
        baselineStore: store,
      });

      // Baseline now reflects the post-action observation (checked=true present).
      const baseline = map.get("s1")!;
      expect(flatChild(baseline.viewHierarchy!.hierarchy.node, 0).checked).toBe("true");
    });

    test("falls back to the full observation when the baseline is missing", () => {
      const { store, map } = makeStore();
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        {
          name: "tapOn",
          sessionUuid: "s1",
          baselineStore: store,
          args: { project: "full" },
        },
      );
      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expectObservationDiff(finalized, { mode: "full", reason: "missing_baseline" });
      // Baseline is now seeded for the next action.
      expect(map.get("s1")).toBeDefined();
    });

    test("falls back to the full observation when the session baseline store is missing", () => {
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        { name: "tapOn", sessionUuid: "s1", args: { project: "full" } },
      );
      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expectObservationDiff(finalized, {
        mode: "full",
        reason: "missing_session",
        hint: "pass sessionUuid from getAndroid/getApple to receive diffs instead of full observations",
      });
    });

    test("default projection still skeletonizes a missing-session full fallback", () => {
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        { name: "tapOn", sessionUuid: "s1" },
      );
      const observation = structuredPayload(finalized).observation;
      expect(observation.isDiff).toBeUndefined();
      expect(observation.skeleton).toBeDefined();
      expect(observation.viewHierarchy).toBeUndefined();
      expectObservationDiff(finalized, {
        mode: "full",
        reason: "missing_session",
        hint: "pass sessionUuid from getAndroid/getApple to receive diffs instead of full observations",
      });
    });

    test("falls back to full when the screen (app/activity/package) changed", () => {
      const { store } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const otherScreen = {
        ...sameScreenObserve(),
        activeWindow: { appId: "com.other", activityName: ".Other", layoutSeqSum: 2 },
      } as ObserveResult;
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: otherScreen }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, args: { project: "full" } },
      );
      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      const metadata = expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
      expect(metadata.fromScreen.activeWindow.appId).toBe("com.example");
      expect(metadata.toScreen.activeWindow.appId).toBe("com.other");
    });

    test("preserves default skeleton projection when the screen changed", () => {
      const { store } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const otherScreen = {
        ...sameScreenObserve(),
        activeWindow: { appId: "com.other", activityName: ".Other", layoutSeqSum: 2 },
      } as ObserveResult;
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: otherScreen }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );
      const observation = structuredPayload(finalized).observation;

      expect(observation.isDiff).toBeUndefined();
      expect(observation.skeleton).toBeDefined();
      expect(observation.viewHierarchy).toBeUndefined();
      expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
    });

    test("falls back to full when an iOS screen identity changes under the same app", () => {
      const { store } = makeStore();
      const baseline = iosScreenObserve("bundle=com.apple.reminders|nav=Reminders");
      finalizeToolResponse(createStructuredToolResponse(baseline), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = checkedIosScreenObserve("bundle=com.apple.reminders|nav=New Reminder");

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        {
          name: "tapOn",
          sessionUuid: "s1",
          baselineStore: store,
          args: { project: "full" },
        },
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expect(obsSc.screenIdentity.key).toBe("bundle=com.apple.reminders|nav=New Reminder");
      const metadata = expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
      expect(metadata.fromScreen.screenIdentity.key).toBe(
        "bundle=com.apple.reminders|nav=Reminders",
      );
      expect(metadata.toScreen.screenIdentity.key).toBe(
        "bundle=com.apple.reminders|nav=New Reminder",
      );
    });

    test("emits a diff when high-confidence iOS screen identity stays stable", () => {
      const { store } = makeStore();
      const baseline = iosScreenObserve("bundle=com.apple.reminders|nav=Reminders");
      finalizeToolResponse(createStructuredToolResponse(baseline), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = checkedIosScreenObserve("bundle=com.apple.reminders|nav=Reminders");

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        {
          name: "tapOn",
          sessionUuid: "s1",
          baselineStore: store,
          args: { project: "full" },
        },
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.changed[0].changes.checked).toEqual({ from: undefined, to: "true" });
      expectObservationDiff(finalized, { mode: "diff", reason: "diff_emitted" });
    });

    test("preserves app/activity/package fallback when only one iOS identity is present", () => {
      const { store } = makeStore();
      finalizeToolResponse(
        createStructuredToolResponse(iosScreenObserve("bundle=com.apple.reminders|nav=Reminders")),
        { name: "observe", sessionUuid: "s1", baselineStore: store },
      );

      const next = {
        ...sameScreenObserve(),
        activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 0 },
        viewHierarchy: {
          packageName: "com.apple.reminders",
          hierarchy: sameScreenObserve().viewHierarchy!.hierarchy,
        },
      } as ObserveResult;
      flatChild(next.viewHierarchy!.hierarchy.node, 0).checked = "true";

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.changed[0].changes.checked).toEqual({ from: undefined, to: "true" });
    });

    test("falls back to full when medium-confidence iOS screen identity changes under the same app", () => {
      const { store } = makeStore();
      const baseline = iosScreenObserve("bundle=com.apple.reminders|tab=Inbox", "medium");
      finalizeToolResponse(createStructuredToolResponse(baseline), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = checkedIosScreenObserve("bundle=com.apple.reminders|tab=Search", "medium");

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        {
          name: "tapOn",
          sessionUuid: "s1",
          baselineStore: store,
          args: { project: "full" },
        },
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expect(obsSc.screenIdentity.key).toBe("bundle=com.apple.reminders|tab=Search");
      expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
    });

    test("falls back to full and updates baseline when iOS screen identity is low confidence", () => {
      const { store, map } = makeStore();
      const baseline = iosScreenObserve("bundle=com.apple.reminders|focus=Title", "low");
      finalizeToolResponse(createStructuredToolResponse(baseline), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = checkedIosScreenObserve("bundle=com.apple.reminders|focus=Title", "low");

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        {
          name: "tapOn",
          sessionUuid: "s1",
          baselineStore: store,
          args: { project: "full" },
        },
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
      expect(flatChild(map.get("s1")!.viewHierarchy!.hierarchy.node, 0).checked).toBe("true");
    });

    test("action policy: navigation-prone tap stays full on uncertain identity", () => {
      const finalized = finalizeChangedLowConfidenceAction("tapOn", { action: "tap" });

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
    });

    test("action policy: sendKeys typing diffs on stable surface despite uncertain identity", () => {
      const finalized = finalizeChangedLowConfidenceAction("sendKeys", {
        commands: [{ action: "type", text: "hello" }],
      });

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.changed[0].changes.checked).toEqual({ from: undefined, to: "true" });
      expectObservationDiff(finalized, { mode: "diff", reason: "diff_emitted" });
    });

    test("action policy: swipeOn diffs on stable surface despite uncertain identity", () => {
      const finalized = finalizeChangedLowConfidenceAction(
        "swipeOn",
        { direction: "up" },
        "bundle=com.apple.reminders|list=Inbox",
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.changed[0].changes.checked).toEqual({ from: undefined, to: "true" });
      expectObservationDiff(finalized, { mode: "diff", reason: "diff_emitted" });
    });

    test("action policy: sendKeys emits full when uncertain identity key changes", () => {
      const finalized = finalizeChangedLowConfidenceAction(
        "sendKeys",
        { commands: [{ action: "type", text: "hello" }] },
        "bundle=com.apple.reminders|focus=Title",
        "bundle=com.apple.reminders|focus=Search",
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
    });

    test("action policy: swipeOn emits full when uncertain identity key changes", () => {
      const finalized = finalizeChangedLowConfidenceAction(
        "swipeOn",
        { direction: "up" },
        "bundle=com.apple.reminders|list=Inbox",
        "bundle=com.apple.reminders|list=Search",
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
    });

    test("action policy: finalizer derives pressButton policy from args", () => {
      const volume = finalizeChangedLowConfidenceAction("pressButton", { button: "volume_up" });
      expect(structuredPayload(volume).observation.isDiff).toBe(true);
      expectObservationDiff(volume, { mode: "diff", reason: "diff_emitted" });

      const back = finalizeChangedLowConfidenceAction("pressButton", { button: "back" });
      expect(structuredPayload(back).observation.isDiff).toBeUndefined();
      expect(structuredPayload(back).observation.viewHierarchy).toBeDefined();
      expectObservationDiff(back, { mode: "full", reason: "screen_changed" });
    });

    test("action policy: submit-style IME actions are navigation-prone", () => {
      const search = finalizeChangedLowConfidenceAction("sendKeys", {
        commands: [{ action: "key", key: "search" }],
      });
      expect(structuredPayload(search).observation.isDiff).toBeUndefined();
      expect(structuredPayload(search).observation.viewHierarchy).toBeDefined();
      expectObservationDiff(search, { mode: "full", reason: "screen_changed" });
    });

    test("action policy: focus-traversal IME actions remain in-place", () => {
      const next = finalizeChangedLowConfidenceAction("sendKeys", {
        commands: [{ action: "key", key: "next" }],
      });
      expect(structuredPayload(next).observation.isDiff).toBe(true);
      expectObservationDiff(next, { mode: "diff", reason: "diff_emitted" });
    });

    // One row per documented action so a single failing case is attributable
    // (#4183 item 17). %j renders the args object into each generated test name.
    const navigationProneActions: Array<[string, Record<string, unknown>]> = [
      ["tapOn", { action: "tap" }],
      ["tapAny", { action: "tap" }],
      ["homeScreen", {}],
      ["recentApps", {}],
      ["openLink", { url: "https://example.com" }],
      ["pressButton", { button: "back" }],
      ["pressButton", { button: "home" }],
      ["pressButton", { button: "recent" }],
      ["pressButton", { button: "power" }],
      ["sendKeys", { commands: [{ action: "key", key: "enter" }] }],
      ["sendKeys", { commands: [{ action: "key", key: "done" }] }],
      ["sendKeys", { commands: [{ action: "key", key: "go" }] }],
      ["sendKeys", { commands: [{ action: "key", key: "search" }] }],
      ["sendKeys", { commands: [{ action: "key", key: "send" }] }],
    ];

    test.each(navigationProneActions)(
      "action policy: %s %j emits full on uncertain identity",
      (name, args) => {
        const finalized = finalizeChangedLowConfidenceAction(name, args);
        expect(structuredPayload(finalized).observation.isDiff).toBeUndefined();
        expect(structuredPayload(finalized).observation.viewHierarchy).toBeDefined();
        expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
      },
    );

    const inPlaceAndScrollActions: Array<[string, Record<string, unknown>]> = [
      ["sendKeys", { commands: [{ action: "type", text: "hello" }] }],
      ["sendKeys", { commands: [{ action: "key", key: "tab" }] }],
      ["sendKeys", { commands: [{ action: "key", key: "next" }] }],
      ["sendKeys", { commands: [{ action: "key", key: "previous" }] }],
      ["sendKeys", { commands: [{ action: "clear" }] }],
      ["selectAllText", {}],
      ["keyboard", { action: "open" }],
      ["clipboard", { action: "paste" }],
      ["pressButton", { button: "menu" }],
      ["pressButton", { button: "volume_up" }],
      ["pressButton", { button: "volume_down" }],
      ["swipeOn", { direction: "up" }],
      ["dragAndDrop", {}],
    ];

    test.each(inPlaceAndScrollActions)(
      "action policy: %s %j diffs on stable uncertain identity",
      (name, args) => {
        const finalized = finalizeChangedLowConfidenceAction(name, args);
        expect(structuredPayload(finalized).observation.isDiff).toBe(true);
        expectObservationDiff(finalized, { mode: "diff", reason: "diff_emitted" });
      },
    );

    test("falls back to full when there is no sessionUuid (legacy single-agent path)", () => {
      const { store, map } = makeStore();
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        { name: "tapOn", baselineStore: store, args: { project: "full" } },
      );
      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expectObservationDiff(finalized, {
        mode: "full",
        reason: "missing_session",
        hint: "pass sessionUuid from getAndroid/getApple to receive diffs instead of full observations",
      });
      expect(map.size).toBe(0);
    });

    test("observe resets the baseline after a diff-producing action", () => {
      const { store, map } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });
      const first = map.get("s1");
      // An observe with a different hierarchy overwrites the baseline wholesale.
      const reset = sameScreenObserve();
      flatNode(reset.viewHierarchy!.hierarchy.node)["content-desc"] = "changed-root";
      finalizeToolResponse(createStructuredToolResponse(reset), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });
      const second = map.get("s1")!;
      expect(second).not.toBe(first);
      expect(flatNode(second.viewHierarchy!.hierarchy.node)["content-desc"]).toBe("changed-root");
    });

    test("diff path is output-only — the caller's in-memory observation is untouched", () => {
      const { store } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });
      const next = sameScreenObserve();
      flatChild(next.viewHierarchy!.hierarchy.node, 0).checked = "true";
      const before = JSON.stringify(next);
      finalizeToolResponse(createStructuredToolResponse({ success: true, observation: next }), {
        name: "tapOn",
        sessionUuid: "s1",
        baselineStore: store,
      });
      expect(JSON.stringify(next)).toBe(before);
    });

    test("skeleton diffs carry tuple-shaped bounds in compact added rows", () => {
      // The diff runs on the sanitized (always-compacted) observation, so a node
      // surfaced in the diff carries the tuple bounds, not the object shape.
      const { store } = makeStore();
      const withBounds = (): ObserveResult =>
        ({
          ...makeObserveResult(),
          activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
          viewHierarchy: {
            packageName: "com.example",
            hierarchy: {
              node: {
                "resource-id": "com.example:id/root",
                bounds: { left: 0, top: 0, right: 100, bottom: 100 },
              },
            },
          },
        }) as ObserveResult;

      finalizeToolResponse(createStructuredToolResponse(withBounds()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = withBounds();
      flatNode(next.viewHierarchy!.hierarchy.node).node = [
        {
          "resource-id": "com.example:id/added",
          clickable: true,
          bounds: { left: 5, top: 6, right: 7, bottom: 8 },
        },
      ];
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.added).toHaveLength(1);
      expect(obsSc.added[0].attributes).toEqual({
        elementId: "com.example:id/added",
        affordances: ["tap"],
        bounds: [5, 6, 7, 8],
      });
      expectObservationDiff(finalized, { mode: "diff", reason: "diff_emitted" });
    });
    test("skeleton action diffs stay compact while full projection preserves raw warning and node shapes", () => {
      const statusWarning = (description: string) => ({
        type: "important-content-under-inset" as const,
        severity: "warning" as const,
        element: {
          contentDesc: description,
          bounds: { left: 0, top: 0, right: 20, bottom: 20 },
        },
        categories: ["text"] as Array<"text">,
        insetTypes: ["systemBars"] as Array<"systemBars">,
        sides: ["top"] as Array<"top">,
        overflowPx: { top: 20 },
        insetPx: { top: 24 },
        overlapPercent: 100,
        confidence: "high" as const,
      });
      const makeListObservation = (
        notificationPrefix: string,
        includeRows: boolean,
      ): ObserveResult => ({
        ...sameScreenObserve(),
        layoutWarnings: {
          scope: "full",
          warnings: Array.from({ length: 8 }, (_, index) =>
            statusWarning(`${notificationPrefix} ${index} notification:`),
          ),
        },
        viewHierarchy: {
          packageName: "com.example",
          hierarchy: {
            node: {
              "resource-id": "com.example:id/root",
              bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
              node: includeRows
                ? Array.from({ length: 30 }, (_, index) => ({
                    "resource-id": `com.example:id/result_${index}`,
                    text: `Search result ${index}`,
                    clickable: true,
                    actions: ["click", "long_click"],
                    class: "android.widget.TextView",
                    occlusionState: "visible",
                    bounds: {
                      left: 0,
                      top: 100 + index * 40,
                      right: 1080,
                      bottom: 136 + index * 40,
                    },
                  }))
                : [],
            },
          },
        },
      });
      const baseline = makeListObservation("Old", false);
      const next = makeListObservation("New", true);

      const { store: skeletonStore } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(baseline), {
        name: "observe",
        sessionUuid: "skeleton",
        baselineStore: skeletonStore,
      });
      const skeleton = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        {
          name: "tapOn",
          sessionUuid: "skeleton",
          baselineStore: skeletonStore,
        },
      );
      const skeletonObservation = structuredPayload(skeleton).observation;
      expect(
        Buffer.byteLength(stringifyToolResponse(structuredPayload(skeleton)), "utf8"),
      ).toBeLessThan(8 * 1024);
      expect(skeletonObservation.skeleton).toBeDefined();
      expect(skeletonObservation.fields?.layoutWarnings).toBeUndefined();
      expect(skeletonObservation.added[0].attributes).toEqual({
        elementId: "com.example:id/result_0",
        label: "Search result 0",
        affordances: ["tap", "long-press"],
        bounds: [0, 100, 1080, 136],
      });

      const { store: fullStore } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(baseline), {
        name: "observe",
        sessionUuid: "full",
        baselineStore: fullStore,
      });
      const full = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        {
          name: "tapOn",
          args: { project: "full" },
          sessionUuid: "full",
          baselineStore: fullStore,
        },
      );
      const fullObservation = structuredPayload(full).observation;
      expect(fullObservation.fields.layoutWarnings.from.warnings).toHaveLength(8);
      expect(fullObservation.fields.layoutWarnings.to.warnings).toHaveLength(8);
      expect(fullObservation.fields.layoutWarnings.from.warnings[0].element.bounds).toEqual([
        0, 0, 20, 20,
      ]);
      expect(fullObservation.added[0].attributes.actions).toEqual(["click", "long_click"]);
    });
  });

  describe("observation artifact mode (#3480)", () => {
    let originalDiff: boolean;
    let originalNoObserve: boolean;

    function sameScreenObserve(): ObserveResult {
      return {
        ...makeObserveResultWithBounds(),
        activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
        viewHierarchy: {
          packageName: "com.example",
          hierarchy: {
            node: {
              "resource-id": "com.example:id/root",
              bounds: { left: 0, top: 0, right: 100, bottom: 100 },
              node: [{ "resource-id": "com.example:id/child", text: "Hello" }],
            },
          },
        },
      } as ObserveResult;
    }

    function makeStore(): {
      store: {
        get: (u: string) => ObserveResult | undefined;
        set: (u: string, o: ObserveResult) => void;
      };
      map: Map<string, ObserveResult>;
    } {
      const map = new Map<string, ObserveResult>();
      return {
        map,
        store: {
          get: (u: string) => map.get(u),
          set: (u: string, o: ObserveResult) => {
            map.set(u, o);
          },
        },
      };
    }

    beforeEach(() => {
      originalDiff = serverConfig.isActionsDiffObserveEnabled();
      originalNoObserve = serverConfig.isActionsNoObserveEnabled();
      serverConfig.setActionsDiffObserveEnabled(false);
      serverConfig.setActionsNoObserveEnabled(false);
    });

    afterEach(() => {
      serverConfig.setActionsDiffObserveEnabled(originalDiff);
      serverConfig.setActionsNoObserveEnabled(originalNoObserve);
    });

    test("observe returns artifact metadata instead of an inline ObserveResult", () => {
      const writer = new FakeObservationArtifactWriter();
      const finalized = finalizeToolResponse(
        createStructuredToolResponse(makeObserveResult()),
        // project:"full" so the artifacted observation is the full sanitized tree
        // (the view-id dedup under test) rather than the default skeleton.
        {
          name: "observe",
          sessionUuid: "s1",
          artifactWriter: writer,
          args: { project: "full" },
        },
      );

      expect(structuredPayload(finalized)).toEqual({
        artifact: {
          path: "/tmp/auto-mobile/observe-1.json",
          format: "json",
          payload: "ObserveResult",
          bytes: 123,
          tool: "observe",
          resourceUri: "automobile:tool-output/observe-1",
        },
      });
      expect(structuredPayload(finalized).viewHierarchy).toBeUndefined();
      expect(writer.writes).toHaveLength(1);
      expect(writtenObservationNode(writer.writes[0].data)["view-id"]).toBeUndefined();
      expect(finalized.content[0].text).toBe(stringifyToolResponse(structuredPayload(finalized)));
    });

    test("artifacted observe keeps wait status inline", () => {
      const writer = new FakeObservationArtifactWriter();
      const timeoutReason =
        'Timed out after 5000 ms waiting for posture "closed"; last observed posture "opened"';
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({
          ...makeObserveResult(),
          matched: false,
          timedOut: true,
          timeoutReason,
          polls: 3,
          waitMs: 250,
        }),
        { name: "observe", sessionUuid: "s1", artifactWriter: writer },
      );

      expect(structuredPayload(finalized)).toMatchObject({
        artifact: expect.any(Object),
        matched: false,
        timedOut: true,
        timeoutReason,
        polls: 3,
        waitMs: 250,
      });
      expect(writer.writes[0].data).toMatchObject({ matched: false, timedOut: true });
      expect(JSON.parse(finalized.content[0].text).timeoutReason).toBe(timeoutReason);
    });

    test("action observation fields are replaced with artifact metadata", () => {
      const writer = new FakeObservationArtifactWriter();
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: makeObserveResult() }),
        // project:"full" keeps the raw hierarchy under test; the assertions below
        // check that the FULL observation (not the #5872 skeleton default) is the
        // payload handed to the artifact writer.
        {
          name: "tapOn",
          sessionUuid: "s1",
          args: { project: "full" },
          artifactWriter: writer,
        },
      );

      expect(structuredPayload(finalized).success).toBe(true);
      expect(structuredPayload(finalized).observation).toEqual({
        artifact: {
          path: "/tmp/auto-mobile/tapOn-1.json",
          format: "json",
          payload: "ObserveResult",
          bytes: 123,
          tool: "tapOn",
          resourceUri: "automobile:tool-output/tapOn-1",
        },
      });
      expect(structuredPayload(finalized).observation.viewHierarchy).toBeUndefined();
      expect(writtenObservationNode(writer.writes[0].data)["view-id"]).toBeUndefined();
      expect(JSON.parse(finalized.content[0].text)).toEqual(structuredPayload(finalized));
    });

    test("full-projection diff spills the complete diff and returns only artifact metadata", () => {
      serverConfig.setActionsDiffObserveEnabled(true);
      const { store } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = sameScreenObserve();
      next.freshness = {
        isFresh: false,
        category: "unavailable",
        unavailableDetail: "capture unavailable",
      };
      flatNode(next.viewHierarchy!.hierarchy.node).node = [
        { "resource-id": "com.example:id/added", bounds: { left: 5, top: 6, right: 7, bottom: 8 } },
      ];
      const writer = new FakeObservationArtifactWriter();

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        {
          name: "tapOn",
          sessionUuid: "s1",
          args: { project: "full" },
          baselineStore: store,
          artifactWriter: writer,
        },
      );

      expect(writer.writes[0].data).toMatchObject({ isDiff: true });
      expect(writer.writes[0].payload).toBe("ObserveDiff");
      expect(writer.writes[0].data).toMatchObject({
        added: [{ attributes: { bounds: [5, 6, 7, 8] } }],
        skeleton: expect.anything(),
        freshness: next.freshness,
      });
      expect(structuredPayload(finalized).observation).toEqual({
        artifact: {
          path: "/tmp/auto-mobile/tapOn-1.json",
          format: "json",
          payload: "ObserveDiff",
          bytes: 123,
          tool: "tapOn",
          resourceUri: "automobile:tool-output/tapOn-1",
        },
      });
      expect(structuredPayload(finalized).observationDiff).toMatchObject({
        mode: "diff",
        reason: "diff_emitted",
      });
      expect(finalized.content[0].text).toBe(stringifyToolResponse(structuredPayload(finalized)));
    });

    test("skeleton diff spill has a schema-valid non-diff inline shell with arrays in the artifact", () => {
      serverConfig.setActionsDiffObserveEnabled(true);
      const { store } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });
      const next = sameScreenObserve();
      next.freshness = {
        isFresh: false,
        category: "unavailable",
        unavailableDetail: "capture unavailable",
      };
      flatNode(next.viewHierarchy!.hierarchy.node).node = [
        { "resource-id": "com.example:id/added", bounds: { left: 5, top: 6, right: 7, bottom: 8 } },
      ];
      const writer = new FakeObservationArtifactWriter();
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, artifactWriter: writer },
      );
      const observation = structuredPayload(finalized).observation;
      expect(observationOutputSchema.safeParse(observation).success).toBe(true);
      expect(observationSummarySchema.safeParse(observation).success).toBe(true);
      expect(observation.isDiff).toBeUndefined();
      expect(observation.added).toBeUndefined();
      expect(observation.removed).toBeUndefined();
      expect(observation.changed).toBeUndefined();
      expect(observation.skeleton).toBeDefined();
      expect(observation.freshness).toEqual(next.freshness);
      expect(writer.writes[0].data).toMatchObject({
        isDiff: true,
        added: expect.any(Array),
        removed: expect.any(Array),
        changed: expect.any(Array),
      });
    });

    test("internal calls receive full observations and do not write artifacts", () => {
      serverConfig.setActionsNoObserveEnabled(true);
      const writer = new FakeObservationArtifactWriter();

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: makeObserveResult() }),
        { name: "tapOn", sessionUuid: "s1", internal: true, artifactWriter: writer },
      );

      expect(writer.writes).toHaveLength(0);
      expect(structuredPayload(finalized).observation.viewHierarchy).toBeDefined();
      expect(structuredPayload(finalized).observation.artifact).toBeUndefined();
      expect(finalized.content[0].text).toBe(stringifyToolResponse(structuredPayload(finalized)));
    });

    test("read-only observe artifact write failures stay loud and do not produce inline fallback output", () => {
      const writer = new FakeObservationArtifactWriter();
      writer.throwOnWrite = new Error("artifact disk is full");
      const response = createStructuredToolResponse(makeObserveResult());

      expect(() =>
        finalizeToolResponse(response, {
          name: "observe",
          sessionUuid: "s1",
          artifactWriter: writer,
        }),
      ).toThrow("artifact disk is full");
      expect(structuredPayload(response).viewHierarchy).toBeDefined();
      expect(structuredPayload(response).artifact).toBeUndefined();
    });

    test("a failed artifact write does not turn a performed tapOn into an error (#10080)", () => {
      const writer = new FakeObservationArtifactWriter();
      writer.throwOnWrite = new Error("artifact disk is full");
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

      try {
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({ success: true, observation: makeObserveResult() }),
          { name: "tapOn", sessionUuid: "s1", artifactWriter: writer },
        );

        const structured = structuredPayload(finalized);
        expect(structured.success).toBe(true);
        expect(structured.observation.skeleton).toBeDefined();
        expect(structured.observation.artifact).toBeUndefined();
        expect(finalized.content[0].text).toBe(stringifyToolResponse(structured));
        const warning = warnSpy.mock.calls.map((call) => String(call[0])).join("\n");
        expect(warning).toContain("could not write the observation artifact for tapOn");
        expect(warning).toContain("artifact disk is full");
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("a failed oversized-observation artifact write serves the action result inline (#10080)", () => {
      const writer = new FakeObservationArtifactWriter();
      writer.throwOnWrite = new Error("EROFS: read-only file system");
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
      const observation = makeObserveResult();
      observation.freshness = { isFresh: true, note: "z".repeat(70_000) } as never;

      try {
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({ success: true, observation }),
          { name: "tapOn", artifactMode: "oversized", artifactWriter: writer },
        );

        const structured = structuredPayload(finalized);
        expect(structured.success).toBe(true);
        expect(structured.observation.artifact).toBeUndefined();
        expect(structured.artifact).toBeUndefined();
        expect(warnSpy.mock.calls.length).toBeGreaterThan(0);
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("a failed artifact write still advances the diff baseline to what was served inline (#10080)", () => {
      serverConfig.setActionsDiffObserveEnabled(true);
      const { store, map } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });
      const renderedBaseline = map.get("s1");
      const next = sameScreenObserve();
      flatNode(next.viewHierarchy!.hierarchy.node).node = [
        {
          "resource-id": "com.example:id/not-rendered",
          bounds: { left: 1, top: 2, right: 3, bottom: 4 },
        },
      ];
      const writer = new FakeObservationArtifactWriter();
      writer.throwOnWrite = new Error("artifact disk is full");
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

      try {
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({ success: true, observation: next }),
          { name: "tapOn", sessionUuid: "s1", baselineStore: store, artifactWriter: writer },
        );

        expect(structuredPayload(finalized).success).toBe(true);
        expect(structuredPayload(finalized).observation.artifact).toBeUndefined();
        expect(map.get("s1")).not.toBe(renderedBaseline);
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("an artifact write failure keeps the always-mode executePlan result inline (#10080)", () => {
      const writer = new FakeObservationArtifactWriter();
      writer.throwOnWrite = new Error("artifact disk is full");
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
      const failureObservation = { capturedAtMs: 1, viewHierarchy: { hierarchy: { node: {} } } };

      try {
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({
            success: false,
            failedStep: { index: 1, failureObservation },
          }),
          { name: "executePlan", artifactMode: "always", artifactWriter: writer },
        );

        expect(structuredPayload(finalized).failedStep.failureObservation).toEqual(
          failureObservation,
        );
        expect(warnSpy.mock.calls.length).toBeGreaterThan(0);
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("a read-only getNetworkGraph keeps its always-mode artifact failure loud", () => {
      const writer = new FakeObservationArtifactWriter();
      writer.throwOnWrite = new Error("artifact disk is full");

      expect(() =>
        finalizeToolResponse(
          createStructuredToolResponse({
            graph: [{ scheme: "https", host: "api.example.com", paths: {} }],
          }),
          { name: "getNetworkGraph", artifactMode: "always", artifactWriter: writer },
        ),
      ).toThrow("artifact disk is full");
    });

    describe("oversized artifact-mode 64KB boundary (#4183 item 4)", () => {
      // In "oversized" mode only a served payload whose serialized size exceeds
      // the 64KB inline ceiling is routed to the artifact writer; anything at or
      // under the threshold stays inline. These tests pin the exact 65536-byte
      // boundary (shouldArtifactObservationPayload uses a strict `>` comparison).
      //
      // The payloads below are sized against the LITERAL 65536/65537 byte counts,
      // not the DEFAULT_OBSERVATION_INLINE_MAX_BYTES symbol, so a change to the
      // production threshold breaks these tests instead of silently sliding with
      // it. This canary makes the literal↔constant coupling explicit: if it
      // fails, the boundary moved and the literals below must be re-derived.
      const INLINE_MAX_BYTES = 65536;
      const FIRST_ARTIFACT_BYTES = 65537;
      test("the production inline ceiling is still 65536 bytes", () => {
        expect(DEFAULT_OBSERVATION_INLINE_MAX_BYTES).toBe(INLINE_MAX_BYTES);
      });

      const oversizedCtx = (writer: FakeObservationArtifactWriter) => ({
        name: "tapOn",
        artifactMode: "oversized",
        artifactWriter: writer,
      });

      // Build a tapOn response padded so the object measured by the size gate
      // serializes to exactly `targetBytes`. The `pad` field is copied verbatim
      // into the served payload (only `observation` is transformed), so each ASCII
      // char is exactly one UTF-8 byte. A zero-pad probe stays inline — far under
      // 64KB — so its returned structuredContent IS the object the gate measures,
      // giving the base size to calibrate against.
      function tapResponseOfSize(targetBytes: number): StructuredToolResponse {
        const build = (pad: string) =>
          createStructuredToolResponse({ success: true, pad, observation: makeObserveResult() });
        const probe = finalizeToolResponse(
          build(""),
          oversizedCtx(new FakeObservationArtifactWriter()),
        );
        const baseBytes = Buffer.byteLength(
          stringifyToolResponse(structuredPayload(probe)),
          "utf8",
        );
        return build("x".repeat(targetBytes - baseBytes));
      }

      test("a served payload exactly at 65536 bytes stays inline", () => {
        const writer = new FakeObservationArtifactWriter();
        const finalized = finalizeToolResponse(
          tapResponseOfSize(INLINE_MAX_BYTES),
          oversizedCtx(writer),
        );

        expect(Buffer.byteLength(stringifyToolResponse(structuredPayload(finalized)), "utf8")).toBe(
          65536,
        );
        expect(writer.writes).toHaveLength(0);
        // Inline (not artifacted): the observation is present as the #5872 skeleton
        // default, not replaced by artifact metadata.
        expect(structuredPayload(finalized).observation.skeleton).toBeDefined();
        expect(structuredPayload(finalized).observation.artifact).toBeUndefined();
      });

      test("a served payload one byte over 65536 is routed to the artifact writer", () => {
        const writer = new FakeObservationArtifactWriter();
        const finalized = finalizeToolResponse(
          tapResponseOfSize(FIRST_ARTIFACT_BYTES),
          oversizedCtx(writer),
        );

        // The complete URI on the typed fake makes the inline residue exceed
        // the same ceiling, so the response is spilled after its observation.
        expect(writer.writes.map((write) => write.payload)).toEqual([
          "ObserveResult",
          "ToolResponse",
        ]);
        expect(structuredPayload(finalized)).toEqual({
          success: true,
          artifact: {
            path: "/tmp/auto-mobile/tapOn-2.json",
            format: "json",
            payload: "ToolResponse",
            bytes: 123,
            tool: "tapOn",
            resourceUri: "automobile:tool-output/tapOn-2",
          },
        });
        expect(writer.writes[0].data).toMatchObject({ skeleton: expect.anything() });
      });
    });

    /**
     * Issue #6870: spilling `observation` alone leaves everything else inline —
     * `observationDiff` rides at the TOP level, beside it, and so does any bulky
     * tool field. A response could therefore still exceed the inline ceiling
     * after the #5882 spill fired, and over a one-shot `--cli` transport that
     * oversized JSON reached the client cut mid-string. With a writer available
     * the finalized payload must never exceed the ceiling.
     */
    describe("residual overflow after the observation spill (#6870)", () => {
      const oversizedCtx = (writer: FakeObservationArtifactWriter) => ({
        name: "tapOn",
        artifactMode: "oversized",
        artifactWriter: writer,
      });

      const payloadBytes = (finalized: any): number =>
        Buffer.byteLength(stringifyToolResponse(structuredPayload(finalized)), "utf8");

      test("keeps a provisioned session UUID routable after spilling its oversized result", () => {
        const writer = new FakeObservationArtifactWriter();
        const sessionUuid = "provisioned-session-uuid";
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({
            success: true,
            sessionId: sessionUuid,
            operationId: "o".repeat(DEFAULT_OBSERVATION_INLINE_MAX_BYTES + 1),
          }),
          { name: "provisionDevice", artifactMode: "oversized", artifactWriter: writer },
        );

        expect(writer.writes).toHaveLength(1);
        expect(structuredPayload(finalized).sessionId).toBe(sessionUuid);
        expect(getDeviceSessionIdFromResult({ content: finalized.content })).toBe(sessionUuid);
      });

      // `observationDiff` sits at the top level of the served payload, outside
      // `observation`, so the size gate must measure it — and whatever the spill
      // leaves behind must still fit.
      test("bounds a payload whose bulk sits beside the observation", () => {
        const writer = new FakeObservationArtifactWriter();
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({
            success: true,
            observation: makeObserveResult(),
            diffLikeSidecar: { mode: "diff", pad: "y".repeat(70_000) },
          }),
          oversizedCtx(writer),
        );

        const structured = structuredPayload(finalized);
        expect(writer.writes.length).toBeGreaterThan(0);
        expect(payloadBytes(finalized)).toBeLessThanOrEqual(DEFAULT_OBSERVATION_INLINE_MAX_BYTES);
        expect(structured.diffLikeSidecar).toBeUndefined();
      });

      test("spills the residue and keeps the success/error headline inline", () => {
        const writer = new FakeObservationArtifactWriter();
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({
            success: false,
            error: "tap failed",
            pad: "z".repeat(90_000),
            observation: makeObserveResult(),
          }),
          oversizedCtx(writer),
        );

        const structured = structuredPayload(finalized);
        expect(payloadBytes(finalized)).toBeLessThanOrEqual(DEFAULT_OBSERVATION_INLINE_MAX_BYTES);
        expect(structured.success).toBe(false);
        expect(structured.error).toBe("tap failed");
        expect(structured.pad).toBeUndefined();
        expect(structured.artifact).toMatchObject({ format: "json", tool: "tapOn" });
      });

      test("a payload with no observation at all is still bounded", () => {
        const writer = new FakeObservationArtifactWriter();
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({ success: true, rows: "q".repeat(90_000) }),
          oversizedCtx(writer),
        );

        const structured = structuredPayload(finalized);
        expect(payloadBytes(finalized)).toBeLessThanOrEqual(DEFAULT_OBSERVATION_INLINE_MAX_BYTES);
        expect(structured.artifact).toMatchObject({ format: "json", tool: "tapOn" });
        expect(structured.rows).toBeUndefined();
      });

      test("keeps required output-schema fields inline after spilling an executePlan result", () => {
        const writer = new FakeObservationArtifactWriter();
        const outputSchema = z
          .object({
            success: z.boolean(),
            executedSteps: z.number().int(),
            totalSteps: z.number().int(),
            error: z.string().optional(),
          })
          .passthrough();
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({
            success: false,
            executedSteps: 2,
            totalSteps: 3,
            pad: "z".repeat(90_000),
          }),
          {
            name: "executePlan",
            artifactMode: "oversized",
            artifactWriter: writer,
            outputSchema,
          },
        );

        const structured = structuredPayload(finalized);
        expect(writer.writes).toHaveLength(1);
        expect(structured.executedSteps).toBe(2);
        expect(structured.totalSteps).toBe(3);
        expect(structured.pad).toBeUndefined();
      });

      test("keeps an oversized required setUIState fields residue schema-compatible", () => {
        const writer = new FakeObservationArtifactWriter();
        const outputSchema = z.object({
          success: z.boolean(),
          fields: z.array(
            z.object({
              selector: z.object({ text: z.string().optional(), elementId: z.string().optional() }),
              success: z.boolean(),
              attempts: z.number(),
              verified: z.boolean().optional(),
              error: z.string().optional(),
              fieldType: z.enum(["text", "checkbox", "toggle", "dropdown", "unknown"]).optional(),
              skipped: z.boolean().optional(),
              notAttempted: z.boolean().optional(),
              timedOut: z.boolean().optional(),
            }),
          ),
          totalAttempts: z.number(),
          error: z.string().optional(),
        });
        const fields = Array.from({ length: 600 }, (_, index) => ({
          selector: { text: `field-${index}` },
          success: false,
          attempts: 1,
          error: "field update failed: ".repeat(10),
        }));
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({ success: false, fields, totalAttempts: fields.length }),
          {
            name: "setUIState",
            artifactMode: "oversized",
            artifactWriter: writer,
            outputSchema,
          },
        );

        const structured = structuredPayload(finalized);
        expect(writer.writes).toHaveLength(1);
        expect(Array.isArray(structured.fields)).toBe(true);
        expect(outputSchema.safeParse(structured).success).toBe(true);
        expect(structured.fields.length).toBeLessThan(fields.length);
        expect(payloadBytes(finalized)).toBeLessThanOrEqual(DEFAULT_OBSERVATION_INLINE_MAX_BYTES);
      });

      test("uses only the fixed residue keys when no output schema is supplied", () => {
        const writer = new FakeObservationArtifactWriter();
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({
            success: true,
            requiredBySomeSchema: "must remain absent without that schema",
            pad: "z".repeat(90_000),
          }),
          { name: "tapOn", artifactMode: "oversized", artifactWriter: writer },
        );

        const structured = structuredPayload(finalized);
        expect(writer.writes).toHaveLength(1);
        expect(structured.success).toBe(true);
        expect(structured.requiredBySomeSchema).toBeUndefined();
      });

      // The residue kept inline is itself unbounded unless it is capped: a
      // 70 KB `error`, or an observe-wait `candidates` array, is copied back
      // beside the artifact pointer and blows the ceiling all over again.
      test("bounds an oversized error string kept inline", () => {
        const writer = new FakeObservationArtifactWriter();
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({
            success: false,
            error: "e".repeat(70_000),
          }),
          oversizedCtx(writer),
        );

        const structured = structuredPayload(finalized);
        expect(payloadBytes(finalized)).toBeLessThanOrEqual(DEFAULT_OBSERVATION_INLINE_MAX_BYTES);
        expect(typeof structured.error).toBe("string");
        expect(structured.error.startsWith("eeee")).toBe(true);
        expect(structured.error.length).toBeLessThan(70_000);
        expect(structured.artifact).toMatchObject({ format: "json", tool: "tapOn" });
      });

      /**
       * `createStructuredToolResponse` hoists `success`/`error` onto the ENVELOPE
       * beside `content`/`structuredContent` — a third representation of the same
       * payload. Bounding only the structured payload left a 70,000-character
       * `error` sitting at the top level, so the finalized envelope was still
       * ~79 KiB and the two representations disagreed about the same field
       * (#6870 review, PRRT_kwDOP-GF5M6h5Djc).
       */
      test("bounds the hoisted top-level error alongside the spilled payload", () => {
        const writer = new FakeObservationArtifactWriter();
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({
            success: false,
            error: "e".repeat(70_000),
          }),
          oversizedCtx(writer),
        );

        const structured = structuredPayload(finalized);
        expect(finalized.error).toBe(structured.error);
        expect(finalized.success).toBe(false);
        expect(Buffer.byteLength(JSON.stringify(finalized), "utf8")).toBeLessThanOrEqual(
          2 * DEFAULT_OBSERVATION_INLINE_MAX_BYTES,
        );
      });

      // When even the bounded residue overflows, `error` becomes the
      // `{ _truncated, bytes }` marker — a shape the hoisted string field cannot
      // represent. Dropping the hoist keeps the two representations from
      // disagreeing; `success: false` still carries the failure signal.
      test("drops the hoisted error when the residue replaces it with a marker", () => {
        const writer = new FakeObservationArtifactWriter();
        const huge = "\u6f22".repeat(70_000);
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({
            success: false,
            error: huge,
            awaitedElement: huge,
            awaitDuration: huge,
            awaitTimeout: huge,
            matched: huge,
            settled: huge,
            timedOut: huge,
            polls: huge,
            waitMs: huge,
            matchedElement: huge,
            candidates: [huge],
          }),
          oversizedCtx(writer),
        );

        const structured = structuredPayload(finalized);
        expect(structured.error).toEqual({ _truncated: true, bytes: expect.any(Number) });
        expect("error" in finalized).toBe(false);
        expect(finalized.success).toBe(false);
      });

      test("bounds an oversized observe-wait candidates array kept inline", () => {
        const writer = new FakeObservationArtifactWriter();
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({
            success: true,
            matched: false,
            timedOut: true,
            candidates: Array.from({ length: 4_000 }, (_, index) => ({
              text: `candidate-${index}`,
              bounds: { left: index, top: index, right: index + 10, bottom: index + 10 },
            })),
          }),
          oversizedCtx(writer),
        );

        const structured = structuredPayload(finalized);
        expect(payloadBytes(finalized)).toBeLessThanOrEqual(DEFAULT_OBSERVATION_INLINE_MAX_BYTES);
        // The scalar wait verdict still rides inline; only the unbounded array
        // is replaced with a marker pointing at the spilled artifact.
        expect(structured.matched).toBe(false);
        expect(structured.timedOut).toBe(true);
        expect(structured.candidates).toEqual({ _truncated: true, bytes: expect.any(Number) });
      });

      test("keeps the wait timeout reason inline when spilling oversized action residue", () => {
        const writer = new FakeObservationArtifactWriter();
        const timeoutReason =
          'Timed out after 5000 ms waiting for posture "closed"; last observed posture "opened"';
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({
            success: true,
            observation: makeObserveResult(),
            matched: false,
            timedOut: true,
            timeoutReason,
            pad: "z".repeat(90_000),
          }),
          { ...oversizedCtx(writer), name: "openLink" },
        );

        expect(structuredPayload(finalized)).toMatchObject({
          artifact: expect.objectContaining({ payload: "ToolResponse", tool: "openLink" }),
          matched: false,
          timedOut: true,
          timeoutReason,
        });
        expect(JSON.parse(finalized.content[0].text).timeoutReason).toBe(timeoutReason);
        expect(payloadBytes(finalized)).toBeLessThanOrEqual(DEFAULT_OBSERVATION_INLINE_MAX_BYTES);
      });

      test("stays under the ceiling when every retained field is oversized", () => {
        const writer = new FakeObservationArtifactWriter();
        const huge = "h".repeat(70_000);
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({
            success: false,
            error: huge,
            awaitedElement: huge,
            awaitDuration: huge,
            awaitTimeout: huge,
            matched: huge,
            settled: huge,
            timedOut: huge,
            polls: huge,
            waitMs: huge,
            matchedElement: huge,
            candidates: [huge],
          }),
          oversizedCtx(writer),
        );

        expect(payloadBytes(finalized)).toBeLessThanOrEqual(DEFAULT_OBSERVATION_INLINE_MAX_BYTES);
      });

      // A per-field cap counted in UTF-16 code units is not a byte cap: three
      // bytes per unit of CJK/emoji text, times every retained field, is still
      // multiples of the ceiling. The bound has to hold on the serialized bytes.
      test("stays under the ceiling for multi-byte retained fields", () => {
        const writer = new FakeObservationArtifactWriter();
        const huge = "\u6f22".repeat(70_000);
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({
            success: false,
            error: huge,
            awaitedElement: huge,
            awaitDuration: huge,
            awaitTimeout: huge,
            matched: huge,
            settled: huge,
            timedOut: huge,
            polls: huge,
            waitMs: huge,
            matchedElement: huge,
            candidates: [huge],
          }),
          oversizedCtx(writer),
        );

        const structured = structuredPayload(finalized);
        expect(payloadBytes(finalized)).toBeLessThanOrEqual(DEFAULT_OBSERVATION_INLINE_MAX_BYTES);
        expect(structured.artifact).toMatchObject({ format: "json", tool: "tapOn" });
      });

      test("keeps a small error and candidate list verbatim", () => {
        const writer = new FakeObservationArtifactWriter();
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({
            success: false,
            error: "tap failed",
            candidates: [{ text: "Submit" }],
            pad: "z".repeat(90_000),
          }),
          oversizedCtx(writer),
        );

        const structured = structuredPayload(finalized);
        expect(structured.error).toBe("tap failed");
        expect(structured.candidates).toEqual([{ text: "Submit" }]);
      });

      test("leaves an in-limit payload untouched", () => {
        const writer = new FakeObservationArtifactWriter();
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({ success: true, rows: "q".repeat(10) }),
          oversizedCtx(writer),
        );

        expect(structuredPayload(finalized)).toEqual({ success: true, rows: "q".repeat(10) });
        expect(writer.writes).toHaveLength(0);
      });

      /**
       * The gate measured with `stringifyToolResponse`, whose replacer deletes
       * every `extras` property. `structuredContent` is assigned the UNSTRIPPED
       * payload object and serialized by the transport with a plain
       * `JSON.stringify`, so a result whose bulk is accessibility `extras`
       * measured as a few bytes here and was handed to the client at full size —
       * exactly the overflow the ceiling exists to stop (#6870 review).
       */
      test("measures the unstripped structured payload, not the extras-stripped rendering", () => {
        const writer = new FakeObservationArtifactWriter();
        const finalized = finalizeToolResponse(
          createStructuredToolResponse({
            success: true,
            detail: { extras: { accessibility: "x".repeat(70_000) } },
          }),
          oversizedCtx(writer),
        );

        const structured = structuredPayload(finalized);
        expect(writer.writes).toHaveLength(1);
        expect(Buffer.byteLength(JSON.stringify(structured), "utf8")).toBeLessThanOrEqual(
          DEFAULT_OBSERVATION_INLINE_MAX_BYTES,
        );
        expect(structured.detail).toBeUndefined();
        expect(structured.artifact).toMatchObject({ format: "json", tool: "tapOn" });
      });

      // The artifact is advertised as the COMPLETE result, so it must round-trip
      // what would have been served — `extras` included. The spill hands the
      // writer the unstripped payload and its cached complete rendering.
      test("hands the artifact writer the extras-bearing payload itself", () => {
        const writer = new FakeObservationArtifactWriter();
        finalizeToolResponse(
          createStructuredToolResponse({
            success: true,
            detail: { extras: { accessibility: "x".repeat(70_000) } },
          }),
          oversizedCtx(writer),
        );

        expect(writer.writes).toHaveLength(1);
        expect(writer.writes[0].serialized).toBe(JSON.stringify(writer.writes[0].data));
        expect(writer.writes[0].data).toMatchObject({
          detail: { extras: { accessibility: "x".repeat(70_000) } },
        });
      });

      /**
       * A full or read-only tool-output directory must not turn an
       * already-completed tool call into a thrown finalization: the caller gets
       * no result at all and, for a side-effecting tool, may retry an action that
       * already happened. Fall back to the pre-#6870 behaviour — the payload is
       * served un-spilled — and warn (#6870 review).
       */
      test("falls back to the un-spilled payload when the artifact write fails", () => {
        const writer = new FakeObservationArtifactWriter();
        writer.throwOnWrite = new Error("artifact disk is full");
        const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

        try {
          const finalized = finalizeToolResponse(
            createStructuredToolResponse({ success: true, rows: "q".repeat(90_000) }),
            oversizedCtx(writer),
          );

          const structured = structuredPayload(finalized);
          expect(structured.success).toBe(true);
          expect(structured.rows).toBe("q".repeat(90_000));
          expect(structured.artifact).toBeUndefined();
          expect(
            warnSpy.mock.calls.some((call) => String(call[0]).includes("artifact disk is full")),
          ).toBe(true);
        } finally {
          warnSpy.mockRestore();
        }
      });
    });
  });

  describe("non-observation artifact mode (#3481)", () => {
    test("executePlan artifacts large failure/debug observation subtrees and keeps summaries inline", () => {
      const writer = new FakeObservationArtifactWriter();
      const failureObservation = {
        capturedAtMs: 123,
        activeWindow: { appId: "com.example" },
        viewHierarchy: { hierarchy: { node: { "resource-id": "root" } } },
        rawViewHierarchy: '<hierarchy><node text="large" /></hierarchy>',
        visibleTextsSample: ["Submit"],
        resourceIdsSample: ["com.example:id/submit"],
      };
      const stepObservation = {
        capturedAtMs: 456,
        viewHierarchy: { hierarchy: { node: { "resource-id": "step-root" } } },
        visibleTextsSample: ["Step"],
      };
      const debugFailureObservation = {
        capturedAtMs: 789,
        viewHierarchy: { hierarchy: { node: { "resource-id": "debug-failure-root" } } },
        rawViewHierarchy: '<hierarchy><node text="debug failure" /></hierarchy>',
        visibleTextsSample: ["Debug failure"],
      };
      const payload = {
        success: false,
        executedSteps: 1,
        totalSteps: 2,
        failedStep: {
          stepIndex: 1,
          tool: "tapOn",
          error: "Button missing",
          failureObservation,
        },
        debug: {
          executionTimeMs: 50,
          steps: [
            {
              step: "1: observe",
              status: "completed",
              durationMs: 10,
              details: { stepObservation, failureObservation: debugFailureObservation },
            },
          ],
        },
      };

      const finalized = finalizeToolResponse(createStructuredToolResponse(payload), {
        name: "executePlan",
        artifactWriter: writer,
      });

      const failedObservation = structuredPayload(finalized).failedStep.failureObservation;
      expect(failedObservation.capturedAtMs).toBe(123);
      expect(failedObservation.visibleTextsSample).toEqual(["Submit"]);
      expect(failedObservation.resourceIdsSample).toEqual(["com.example:id/submit"]);
      expect(failedObservation.viewHierarchy).toEqual({
        artifact: {
          path: "/tmp/auto-mobile/executePlan-1.json",
          format: "json",
          payload: "ExecutePlanFailureObservationViewHierarchy",
          bytes: 123,
          tool: "executePlan",
          resourceUri: "automobile:tool-output/executePlan-1",
        },
      });
      expect(failedObservation.rawViewHierarchy).toEqual({
        artifact: {
          path: "/tmp/auto-mobile/executePlan-2.json",
          format: "json",
          payload: "ExecutePlanFailureObservationRawViewHierarchy",
          bytes: 123,
          tool: "executePlan",
          resourceUri: "automobile:tool-output/executePlan-2",
        },
      });

      const finalizedStepObservation =
        structuredPayload(finalized).debug.steps[0].details.stepObservation;
      expect(finalizedStepObservation.visibleTextsSample).toEqual(["Step"]);
      expect(finalizedStepObservation.viewHierarchy.artifact.payload).toBe(
        "ExecutePlanDebugStepObservationViewHierarchy",
      );
      const finalizedDebugFailureObservation =
        structuredPayload(finalized).debug.steps[0].details.failureObservation;
      expect(finalizedDebugFailureObservation.visibleTextsSample).toEqual(["Debug failure"]);
      expect(finalizedDebugFailureObservation.viewHierarchy.artifact.payload).toBe(
        "ExecutePlanDebugFailureObservationViewHierarchy",
      );
      expect(finalizedDebugFailureObservation.rawViewHierarchy.artifact.payload).toBe(
        "ExecutePlanDebugFailureObservationRawViewHierarchy",
      );
      expect(writer.writes.map((write) => write.payload)).toEqual([
        "ExecutePlanFailureObservationViewHierarchy",
        "ExecutePlanFailureObservationRawViewHierarchy",
        "ExecutePlanDebugStepObservationViewHierarchy",
        "ExecutePlanDebugFailureObservationViewHierarchy",
        "ExecutePlanDebugFailureObservationRawViewHierarchy",
      ]);
      expect(writer.writes[0].data).toEqual(failureObservation.viewHierarchy);
      expect(writer.writes[1].data).toBe(failureObservation.rawViewHierarchy);
      expect(writer.writes[2].data).toEqual(stepObservation.viewHierarchy);
      expect(writer.writes[3].data).toEqual(debugFailureObservation.viewHierarchy);
      expect(writer.writes[4].data).toBe(debugFailureObservation.rawViewHierarchy);
      expect(finalized.content[0].text).toBe(stringifyToolResponse(structuredPayload(finalized)));
    });

    test("executePlan artifacts the selected failure once and each remaining observation", () => {
      const writer = new FakeObservationArtifactWriter();
      const observation = {
        capturedAtMs: 123,
        visibleTextsSample: ["Submit"],
        viewHierarchy: { hierarchy: { node: { "resource-id": "root" } } },
      };
      const payload = {
        success: false,
        executedSteps: 0,
        totalSteps: 3,
        failedStep: {
          device: "A",
          stepIndex: 0,
          tool: "tapOn",
          error: "missing",
          failureObservation: observation,
        },
        deviceFailures: [
          {
            device: "A",
            stepIndex: 0,
            tool: "tapOn",
            error: "missing",
          },
          {
            device: "B",
            stepIndex: 1,
            tool: "tapOn",
            error: "missing",
            failureObservation: observation,
          },
          { device: "C", stepIndex: -1, tool: "unknown", error: "track failure" },
        ],
      };
      for (const internal of [true, false]) {
        const finalized = finalizeToolResponse(createStructuredToolResponse(payload), {
          name: "executePlan",
          artifactWriter: writer,
          internal,
        });
        const failures = structuredPayload(finalized).deviceFailures;
        expect(failures).toHaveLength(3);
        expect(failures[0]).toEqual(payload.deviceFailures[0]);
        expect(failures[0]).not.toHaveProperty("failureObservation");
        expect(failures[2]).toEqual(payload.deviceFailures[2]);
        if (internal) {
          expect(failures).toEqual(payload.deviceFailures);
          expect(writer.writes).toHaveLength(0);
        } else {
          for (const failure of [structuredPayload(finalized).failedStep, failures[1]]) {
            expect(failure.failureObservation.visibleTextsSample).toEqual(["Submit"]);
            expect(failure.failureObservation.viewHierarchy.artifact.payload).toBe(
              "ExecutePlanFailureObservationViewHierarchy",
            );
          }
          expect(writer.writes.map((write) => write.payload)).toEqual([
            "ExecutePlanFailureObservationViewHierarchy",
            "ExecutePlanFailureObservationViewHierarchy",
          ]);
          expect(writer.writes.map((write) => write.data)).toEqual([
            observation.viewHierarchy,
            observation.viewHierarchy,
          ]);
          expect(finalized.content[0].text).toBe(
            stringifyToolResponse(structuredPayload(finalized)),
          );
        }
      }
      expect(payload.deviceFailures[0]).not.toHaveProperty("failureObservation");
      expect(payload.failedStep.failureObservation).toEqual(observation);
      expect(payload.deviceFailures[1].failureObservation).toEqual(observation);
    });

    test("getNetworkGraph artifacts aggregate graph and keeps host count inline", () => {
      const writer = new FakeObservationArtifactWriter();
      const payload = {
        graph: [
          {
            scheme: "https",
            host: "api.example.com",
            paths: {
              v1: {
                paths: {
                  "users[GET]": { method: "GET", success: 10, errors: 1, p50: 100, p95: 200 },
                },
              },
            },
          },
        ],
      };

      const finalized = finalizeToolResponse(createStructuredToolResponse(payload), {
        name: "getNetworkGraph",
        artifactWriter: writer,
      });

      expect(structuredPayload(finalized)).toEqual({
        graph: {
          artifact: {
            path: "/tmp/auto-mobile/getNetworkGraph-1.json",
            format: "json",
            payload: "NetworkGraph",
            bytes: 123,
            tool: "getNetworkGraph",
            resourceUri: "automobile:tool-output/getNetworkGraph-1",
          },
        },
        graphSummary: { hostCount: 1 },
      });
      expect(writer.writes).toEqual([
        {
          tool: "getNetworkGraph",
          payload: "NetworkGraph",
          data: payload.graph,
          serialized: JSON.stringify(payload.graph),
        },
      ]);
      expect(finalized.content[0].text).toBe(stringifyToolResponse(structuredPayload(finalized)));
    });

    test("internal executePlan calls do not artifact non-observation payloads", () => {
      const writer = new FakeObservationArtifactWriter();
      const payload = {
        success: false,
        executedSteps: 1,
        totalSteps: 2,
        failedStep: {
          stepIndex: 1,
          tool: "tapOn",
          error: "Button missing",
          failureObservation: {
            capturedAtMs: 123,
            viewHierarchy: { hierarchy: { node: { text: "keep inline" } } },
          },
        },
      };

      const finalized = finalizeToolResponse(createStructuredToolResponse(payload), {
        name: "executePlan",
        internal: true,
        artifactWriter: writer,
      });

      expect(writer.writes).toHaveLength(0);
      expect(structuredPayload(finalized)).toEqual(payload);
      expect(finalized.content[0].text).toBe(stringifyToolResponse(payload));
    });
  });

  // --actions-no-observe (#2762, folded into #3026): strip the embedded
  // observation from non-observe tool results entirely. Precedence over
  // --actions-diff-observe — nothing to diff once stripped.
  describe("actions-no-observe strip + precedence (#2762/#3026)", () => {
    let originalNoObserve: boolean;
    let originalDiff: boolean;

    beforeEach(() => {
      originalNoObserve = serverConfig.isActionsNoObserveEnabled();
      originalDiff = serverConfig.isActionsDiffObserveEnabled();
      serverConfig.setActionsNoObserveEnabled(false);
      serverConfig.setActionsDiffObserveEnabled(false);
    });

    afterEach(() => {
      serverConfig.setActionsNoObserveEnabled(originalNoObserve);
      serverConfig.setActionsDiffObserveEnabled(originalDiff);
    });

    test("strips the embedded observation from a non-observe action in both representations", () => {
      serverConfig.setActionsNoObserveEnabled(true);
      const response = createStructuredToolResponse({
        success: true,
        observation: makeObserveResult(),
      });
      const finalized = finalizeToolResponse(response, { name: "tapOn", sessionUuid: "s1" });

      expect(structuredPayload(finalized).observation).toBeUndefined();
      expect(structuredPayload(finalized).observationDiff).toEqual({
        mode: "full",
        reason: "stripped_by_actions_no_observe",
      });
      expect(structuredPayload(finalized).success).toBe(true);
      const parsed = JSON.parse(finalized.content[0].text);
      expect(parsed.observation).toBeUndefined();
      expect(parsed.observationDiff).toEqual(structuredPayload(finalized).observationDiff);
      expect(parsed.success).toBe(true);
      expect(finalized.content[0].text).toBe(stringifyToolResponse(structuredPayload(finalized)));
    });

    test("does not strip the observe tool's own observation", () => {
      serverConfig.setActionsNoObserveEnabled(true);
      const finalized = finalizeToolResponse(createStructuredToolResponse(makeObserveResult()), {
        name: "observe",
        sessionUuid: "s1",
        args: { project: "full" },
      });
      // observe still returns the full (sanitized) observation.
      expect(structuredPayload(finalized).viewHierarchy).toBeDefined();
    });

    test("flag off leaves the observation in place (today's behavior)", () => {
      serverConfig.setActionsNoObserveEnabled(false);
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: makeObserveResult() }),
        { name: "tapOn" },
      );
      expect(structuredPayload(finalized).observation).toBeDefined();
    });

    test("precedence: with both no-observe and diff on, the observation is stripped (no diff)", () => {
      serverConfig.setActionsNoObserveEnabled(true);
      serverConfig.setActionsDiffObserveEnabled(true);
      const map = new Map<string, ObserveResult>();
      const store = {
        get: (u: string) => map.get(u),
        set: (u: string, o: ObserveResult) => {
          map.set(u, o);
        },
      };

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: makeObserveResult() }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );
      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc).toBeUndefined(); // stripped, not a diff
      expect(structuredPayload(finalized).observationDiff).toEqual({
        mode: "full",
        reason: "stripped_by_actions_no_observe",
      });
      // Diff moot → baseline never touched.
      expect(map.size).toBe(0);
    });

    test("non-observe tool without an observation passes through unchanged", () => {
      serverConfig.setActionsNoObserveEnabled(true);
      const payload = { success: true, message: "done" };
      const finalized = finalizeToolResponse(createStructuredToolResponse(payload), {
        name: "pressButton",
      });
      expect(structuredPayload(finalized)).toEqual(payload);
    });
  });

  // Internal tool-to-tool no-diff guard (issue #3053 part 2). PlanExecutor calls
  // the wrapped tool.handler (so finalize runs) with an injected sessionUuid, so a
  // plan step's envelope would get diffed / stripped when the flags are on. Reading
  // `.observation.viewHierarchy` off a diffed or stripped envelope would silently
  // break. `ctx.internal` forces the full sanitized observation regardless of flag.
  describe("internal no-diff guard (#3053)", () => {
    let originalDiff: boolean;
    let originalNoObserve: boolean;

    function sameScreenObserve(): ObserveResult {
      return {
        ...makeObserveResult(),
        activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
        viewHierarchy: {
          packageName: "com.example",
          hierarchy: {
            node: {
              "resource-id": "com.example:id/root",
              "content-desc": "keep-me",
              node: [{ "resource-id": "com.example:id/child", text: "Hello" }],
            },
          },
        },
      } as ObserveResult;
    }

    function makeStore(): {
      store: {
        get: (u: string) => ObserveResult | undefined;
        set: (u: string, o: ObserveResult) => void;
      };
      map: Map<string, ObserveResult>;
    } {
      const map = new Map<string, ObserveResult>();
      return {
        map,
        store: {
          get: (u: string) => map.get(u),
          set: (u: string, o: ObserveResult) => {
            map.set(u, o);
          },
        },
      };
    }

    beforeEach(() => {
      originalDiff = serverConfig.isActionsDiffObserveEnabled();
      originalNoObserve = serverConfig.isActionsNoObserveEnabled();
    });

    afterEach(() => {
      serverConfig.setActionsDiffObserveEnabled(originalDiff);
      serverConfig.setActionsNoObserveEnabled(originalNoObserve);
    });

    test("EC2.1: internal call emits the full observation (no diff) even with a same-screen baseline", () => {
      serverConfig.setActionsDiffObserveEnabled(true);
      serverConfig.setActionsNoObserveEnabled(false);
      const { store, map } = makeStore();
      // Seed a same-screen baseline so a non-internal call WOULD diff.
      map.set("s1", sameScreenObserve());

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, internal: true },
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc.isDiff).toBeUndefined(); // full observation, not a diff
      expect(obsSc.viewHierarchy).toBeDefined();
      expect(structuredPayload(finalized).observationDiff).toBeUndefined();
      // A future internal consumer can still read the hierarchy off the envelope.
      expect(obsSc.viewHierarchy.hierarchy.node["resource-id"]).toBe("com.example:id/root");
    });

    test("EC2.1: internal call leaves the diff baseline untouched", () => {
      serverConfig.setActionsDiffObserveEnabled(true);
      serverConfig.setActionsNoObserveEnabled(false);
      const { store, map } = makeStore();
      map.set("s1", sameScreenObserve());
      const before = map.get("s1");

      finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, internal: true },
      );

      // Internal calls neither read a diff nor advance the agent-facing baseline.
      expect(map.get("s1")).toBe(before);
    });

    test("EC2.2: internal call preserves the observation even with --actions-no-observe on", () => {
      serverConfig.setActionsNoObserveEnabled(true);
      serverConfig.setActionsDiffObserveEnabled(false);

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        { name: "tapOn", sessionUuid: "s1", internal: true },
      );

      const obsSc = structuredPayload(finalized).observation;
      expect(obsSc).toBeDefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expect(structuredPayload(finalized).observationDiff).toBeUndefined();
    });

    test("EC2.2: internal call still sanitizes the observation (view-id dedup applies)", () => {
      serverConfig.setActionsDiffObserveEnabled(true);
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: makeObserveResult() }),
        { name: "tapOn", sessionUuid: "s1", internal: true },
      );
      const node = structuredPayload(finalized).observation.viewHierarchy.hierarchy.node;
      // Sanitization (issue #2758) is independent of the diff guard.
      expect(node["view-id"]).toBeUndefined();
      expect(node.clickable).toBeUndefined();
    });

    test("non-internal same-screen call still diffs (guard is opt-in)", () => {
      serverConfig.setActionsDiffObserveEnabled(true);
      serverConfig.setActionsNoObserveEnabled(false);
      const { store, map } = makeStore();
      map.set("s1", sameScreenObserve());

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, internal: false },
      );

      expect(structuredPayload(finalized).observation.isDiff).toBe(true);
    });
  });

  describe("skeleton projection (issue #4388)", () => {
    // Skeleton is now the unconditional default projection for the headline observe
    // payload; `project:"full"` / `raw:true` opt out. The old project-skeleton flag
    // is gone, so there is no flag to save/restore here.

    /** An observe result whose elements carry bounds so the skeleton is non-empty. */
    function observeWithActionableElements(): ObserveResult {
      const obs = makeObserveResult();
      obs.elements = {
        clickable: [
          {
            bounds: { left: 0, top: 0, right: 100, bottom: 50 },
            "resource-id": "com.example:id/btn",
            text: "Submit",
            clickable: "true",
            "test-tag": "submit-with-terms",
            "semantic-links": [{ text: "Terms", occurrence: 0, start: 7, end: 12 }],
          },
        ],
        scrollable: [],
        text: [],
        media: [],
      };
      return obs;
    }

    test("default (no project arg): observe returns a skeleton and omits viewHierarchy + elements", () => {
      const finalized = finalizeToolResponse(
        createStructuredToolResponse(observeWithActionableElements()),
        { name: "observe" },
      );
      const sc = structuredPayload(finalized) as ObserveResult;
      expect(Array.isArray(sc.skeleton)).toBe(true);
      expect(sc.skeleton!.length).toBeGreaterThan(0);
      expect(sc.viewHierarchy).toBeUndefined();
      expect(sc.elements).toBeUndefined();
      expect(sc.skeleton![0].testTag).toBe("submit-with-terms");
      expect(sc.skeleton![0].semanticLinks).toEqual([
        { text: "Terms", occurrence: 0, start: 7, end: 12 },
      ]);
      // text mirror agrees with structuredContent.
      const parsed = JSON.parse(finalized.content[0].text);
      expect(parsed.skeleton.length).toBe(sc.skeleton!.length);
    });

    test("per-call project:'skeleton' arg also projects to the skeleton", () => {
      const finalized = finalizeToolResponse(
        createStructuredToolResponse(observeWithActionableElements()),
        { name: "observe", args: { project: "skeleton" } },
      );
      const sc = structuredPayload(finalized) as ObserveResult;
      expect(sc.skeleton).toBeDefined();
      expect(sc.viewHierarchy).toBeUndefined();
    });

    test("explicit project:'full' opts out of the skeleton default (full tree returned)", () => {
      const finalized = finalizeToolResponse(
        createStructuredToolResponse(observeWithActionableElements()),
        { name: "observe", args: { project: "full" } },
      );
      const sc = structuredPayload(finalized) as ObserveResult;
      expect(sc.skeleton).toBeUndefined();
      expect(sc.viewHierarchy?.hierarchy).toBeDefined();
    });

    test("raw:true opts out to the full tree", () => {
      const finalized = finalizeToolResponse(
        createStructuredToolResponse(observeWithActionableElements()),
        { name: "observe", args: { raw: true } },
      );
      const sc = structuredPayload(finalized) as ObserveResult;
      expect(sc.skeleton).toBeUndefined();
      expect(sc.viewHierarchy?.hierarchy).toBeDefined();
    });

    test("embedded action observations now skeletonize by default too (#5872 superseded #4388's scoping)", () => {
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({
          success: true,
          observation: observeWithActionableElements(),
        }),
        { name: "tapOn", sessionUuid: "s1" },
      );
      const obsSc = structuredPayload(finalized).observation as ObserveResult;
      // Issue #5872: the skeleton default extended to the action tools' embedded
      // observation, using the same `skeleton` key `observe` uses.
      expect(obsSc.skeleton).toBeDefined();
      expect(obsSc.viewHierarchy).toBeUndefined();
    });
  });
});

/**
 * Observe scope experiments (issue #4344). The per-call `scope` request arrives on
 * the observe tool args. The per-dimension server gates are now always on, so a
 * requested dimension is honored purely from the `scope` arg (nothing is gated
 * off). Scoping is applied to the agent-facing payload only — it must leave the
 * diff baseline (the full sanitized tree) intact and never touch internal
 * tool-to-tool calls. It runs on the FULL projection; the skeleton default
 * replaces the hierarchy, so these tests opt into `project:"full"` to exercise the
 * structural scope transforms.
 */
describe("finalizeToolResponse observe scope experiments (#4344)", () => {
  beforeEach(() => {
    serverConfig.setActionsDiffObserveEnabled(false);
  });

  afterEach(() => {
    serverConfig.setActionsDiffObserveEnabled(false);
  });

  function chromeObserve(): ObserveResult {
    return {
      updatedAt: 1,
      screenSize: { width: 1000, height: 2000 },
      systemInsets: { top: 100, bottom: 100, left: 0, right: 0 },
      activeWindow: { appId: "com.example.app" } as ObserveResult["activeWindow"],
      viewHierarchy: {
        packageName: "com.example.app",
        hierarchy: {
          node: {
            class: "Root",
            bounds: { left: 0, top: 0, right: 1000, bottom: 2000 },
            // Package-qualified resource-ids are the app-vs-chrome signal that
            // survives cleanNodeProperties (per-node `package` does not).
            node: [
              {
                "resource-id": "com.android.systemui:id/status_bar",
                bounds: { left: 0, top: 0, right: 1000, bottom: 100 },
              },
              {
                "resource-id": "com.example.app:id/content",
                text: "Hi",
                bounds: { left: 0, top: 100, right: 1000, bottom: 1900 },
              },
            ],
          },
        },
      },
    } as ObserveResult;
  }

  test("requested scope dimensions are no longer gated off (gates are always on)", () => {
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      args: { project: "full", scope: { focus: true, region: true, overview: true } },
    });
    const out = structuredPayload(finalized) as ObserveResult;
    // Nothing is gated off now, and the scope transforms materially prune the tree.
    expect(out.observeScope!.gatedOff).toBeUndefined();
    expect(out.observeScope!.applied).toContain("focus");
    expect(out.observeScope!.nodesAfter).toBeLessThan(out.observeScope!.nodesBefore);
  });

  test("multiple requested dimensions are all honored (none gated off)", () => {
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      args: { project: "full", scope: { focus: true, region: true } },
    });
    const out = structuredPayload(finalized) as ObserveResult;
    expect(out.observeScope).toMatchObject({ applied: ["focus"] });
    expect(out.observeScope!.gatedOff).toBeUndefined();
  });

  test("no scope in the call: payload is untouched (scope is a no-op)", () => {
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      args: { project: "full" },
    });
    expect((structuredPayload(finalized) as ObserveResult).observeScope).toBeUndefined();
  });

  test("scope.focus in the call scopes the payload and records observeScope", () => {
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      args: { project: "full", scope: { focus: true } },
    });
    const out = structuredPayload(finalized) as ObserveResult;
    expect(out.observeScope?.applied).toContain("focus");
    expect(out.observeScope!.nodesAfter).toBeLessThan(out.observeScope!.nodesBefore);
    // text mirror agrees with structuredContent.
    expect(finalized.content[0].text).toBe(stringifyToolResponse(structuredPayload(finalized)));
  });

  test("explicit skeleton projection returns the skeleton; scope transforms cannot run on it", () => {
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      args: {
        project: "skeleton",
        scope: { focus: true, region: true, overview: true },
      },
    });

    const out = structuredPayload(finalized) as ObserveResult;
    expect(out.skeleton).toEqual([]);
    expect(out.viewHierarchy).toBeUndefined();
    expect(out.elements).toBeUndefined();
    // Gates are always on, so nothing is gated off; the skeleton replaces the
    // hierarchy, so no scope transform runs and no observeScope is recorded.
    expect(out.observeScope).toBeUndefined();
    expect(finalized.content[0].text).toBe(stringifyToolResponse(structuredPayload(finalized)));
  });

  test("default skeleton + scope: skeleton returned, no observeScope (nothing gated off)", () => {
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      args: { scope: { focus: true, region: true } },
    });

    const out = structuredPayload(finalized) as ObserveResult;
    expect(out.skeleton).toEqual([]);
    expect(out.viewHierarchy).toBeUndefined();
    expect(out.observeScope).toBeUndefined();
    expect(finalized.content[0].text).toBe(stringifyToolResponse(structuredPayload(finalized)));
  });

  test("scope.region box in the call crops to the normalized rectangle", () => {
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      args: { project: "full", scope: { region: { x1: 0, y1: 0, x2: 1, y2: 0.5 } } }, // top half only
    });
    const out = structuredPayload(finalized) as ObserveResult;
    expect(out.observeScope?.regionPx).toEqual({ left: 0, top: 0, right: 1000, bottom: 1000 });
  });

  test("internal observe calls are never scoped", () => {
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      internal: true,
      args: { project: "full", scope: { focus: true } },
    });
    expect((structuredPayload(finalized) as ObserveResult).observeScope).toBeUndefined();
  });

  test("diff baseline is the full sanitized tree, not the scoped copy", () => {
    serverConfig.setActionsDiffObserveEnabled(true);
    const map = new Map<string, ObserveResult>();
    const store = {
      get: (u: string) => map.get(u),
      set: (u: string, o: ObserveResult) => {
        map.set(u, o);
      },
    };

    finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      sessionUuid: "s1",
      baselineStore: store,
      args: { project: "full", scope: { focus: true } },
    });

    // Baseline retains the system-chrome node the served payload dropped.
    const baseline = map.get("s1")!;
    expect(baseline.observeScope).toBeUndefined();
    const ids: string[] = [];
    const walk = (n: any): void => {
      if (n["resource-id"]) {
        ids.push(n["resource-id"]);
      }
      for (const c of n.node ?? []) {
        walk(c);
      }
    };
    walk(baseline.viewHierarchy!.hierarchy.node);
    expect(ids).toContain("com.android.systemui:id/status_bar");
  });
});

describe("finalizeToolResponse — scope-then-cap for layoutWarnings (issue #5074 finding 3)", () => {
  test("an in-region warning survives even when 100+ higher-priority warnings are out of region", () => {
    const W = 1080,
      H = 2400;
    // One in-region node (top) plus 120 out-of-region nodes (bottom), each distinct bounds.
    const inRegionBounds = { left: 0, top: 100, right: 200, bottom: 160 };
    const outNodes = Array.from({ length: 120 }, (_, i) => ({
      "resource-id": `com.example:id/out_${i}`,
      bounds: { left: 0, top: 1300 + i, right: 200, bottom: 1360 + i },
    }));
    const mkWarning = (
      bounds: Record<string, number>,
      severity: "warning" | "info",
      overflow: number,
    ): any => ({
      type: "important-content-under-inset",
      severity,
      element: { bounds },
      categories: ["text"],
      insetTypes: ["systemBars"],
      sides: ["top"],
      overflowPx: { top: overflow },
      insetPx: { top: overflow },
      overlapPercent: 100,
      confidence: "medium",
    });
    const obs = {
      updatedAt: 1,
      screenSize: { width: W, height: H },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      activeWindow: { appId: "com.example" },
      viewHierarchy: {
        packageName: "com.example",
        hierarchy: {
          node: {
            "resource-id": "com.example:id/root",
            bounds: { left: 0, top: 0, right: W, bottom: H },
            node: [{ text: "in", bounds: inRegionBounds }, ...outNodes],
          },
        },
      },
      layoutWarnings: {
        scope: "full",
        warnings: [
          // In-region warning is deliberately LOW priority, so a cap taken BEFORE
          // scoping (the bug) would evict it in favor of the 120 out-of-region ones.
          mkWarning(inRegionBounds, "info", 1),
          ...outNodes.map((n) => mkWarning(n.bounds, "warning", 999)),
        ],
      },
    } as unknown as ObserveResult;

    const finalized = finalizeToolResponse(createStructuredToolResponse(obs), {
      name: "observe",
      // project:"full" keeps the real hierarchy (default is the skeleton projection,
      // which replaces it and cannot co-scope warnings).
      args: { project: "full", scope: { region: { x1: 0, y1: 0, x2: 1, y2: 0.5 } } },
    });

    // Scope-then-cap: the crop keeps only the in-region node, so its warning is the
    // sole survivor — never evicted by the 120 higher-priority out-of-region ones.
    const served = structuredPayload(finalized) as ObserveResult;
    expect(served.layoutWarnings?.scope).toBe("scoped");
    expect(served.layoutWarnings?.warnings).toHaveLength(1);
  });
});

describe("actions-compact-metadata", () => {
  const metadata = {
    insets: { available: false, source: "unavailable", reason: "test" },
    systemInsets: { top: 24, bottom: 0, left: 0, right: 0 },
    backStack: { depth: 1 },
    gfxMetrics: { isStable: true },
    displayedTimeMetrics: [{ displayedMs: 10 }],
    deviceLock: { isLocked: false },
    accessibilityState: { enabled: false, service: "unknown" },
    freshness: { verified: true, isFresh: true },
  };
  const element = { text: "Hello", bounds: { left: 0, top: 0, right: 100, bottom: 100 } };
  let compact: boolean;
  let diff: boolean;
  let noObserve: boolean;
  let store: import("../../src/server/finalizeToolResponse").ObservationBaselineStore;
  let records: Map<string, { deviceId: string; blocks: Record<string, unknown> }>;
  let baselines: Map<string, ObserveResult>;

  beforeEach(() => {
    compact = serverConfig.isActionsCompactMetadataEnabled();
    diff = serverConfig.isActionsDiffObserveEnabled();
    noObserve = serverConfig.isActionsNoObserveEnabled();
    serverConfig.setActionsCompactMetadataEnabled(true);
    serverConfig.setActionsDiffObserveEnabled(false);
    serverConfig.setActionsNoObserveEnabled(false);
    // Extend the same Map-backed fake used by the existing diff tests.
    baselines = new Map();
    records = new Map();
    store = {
      get: (uuid) => baselines.get(uuid),
      set: (uuid, observation) => {
        baselines.set(uuid, observation);
      },
      getActionMetadata: (uuid, deviceId) => {
        const record = records.get(uuid);
        return record?.deviceId === deviceId ? record.blocks : undefined;
      },
      setActionMetadata: (uuid, deviceId, blocks) => {
        records.set(uuid, { deviceId, blocks });
      },
    };
  });
  afterEach(() => {
    serverConfig.setActionsCompactMetadataEnabled(compact);
    serverConfig.setActionsDiffObserveEnabled(diff);
    serverConfig.setActionsNoObserveEnabled(noObserve);
  });

  function action(deviceId = "phone-a"): Record<string, unknown> {
    return {
      success: true,
      element: structuredClone(element),
      selectedElement: { matchedElement: structuredClone(element) },
      observation: { ...makeObserveResult(), ...structuredClone(metadata), deviceId },
    };
  }
  function emit(
    payload = action(),
    overrides: Partial<
      import("../../src/server/finalizeToolResponse").FinalizeToolResponseContext
    > = {},
  ) {
    return finalizeToolResponse(createStructuredToolResponse(payload), {
      name: "tapOn",
      sessionUuid: "s1",
      baselineStore: store,
      ...overrides,
    });
  }
  function observation(response: ReturnType<typeof emit>): Record<string, unknown> {
    return structuredPayload(response).observation as Record<string, unknown>;
  }
  function expectFull(response: ReturnType<typeof emit>) {
    for (const key of Object.keys(metadata)) {
      expect(observation(response)).toHaveProperty(key);
    }
  }

  test("explicit opt-out keeps finalized bytes identical; missing session/store are also unchanged", () => {
    emit();
    const snapshot = structuredClone(records);
    const reads = spyOn(store, "getActionMetadata");
    const writes = spyOn(store, "setActionMetadata");
    serverConfig.setActionsCompactMetadataEnabled(false);
    const expected = JSON.stringify(emit());
    expect(JSON.stringify(emit())).toBe(expected);
    emit(action().observation as Record<string, unknown>, { name: "observe" });
    emit({ ...action(), success: false });
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(records).toEqual(snapshot);
    reads.mockRestore();
    writes.mockRestore();
    records.clear();
    serverConfig.setActionsCompactMetadataEnabled(true);
    expect(JSON.stringify(emit(action(), { sessionUuid: undefined }))).toBe(expected);
    expect(JSON.stringify(emit(action(), { baselineStore: undefined }))).toBe(expected);
    expect(records.size).toBe(0);
  });
  test("default configuration sends full first/new-session/device-switch blocks and compacts repeats", () => {
    serverConfig.setActionsCompactMetadataEnabled(
      parseOutputReductionFlags([], {}).actionsCompactMetadata,
    );
    expectFull(emit());
    const repeated = observation(emit());
    for (const key of Object.keys(metadata)) {
      expect(repeated).not.toHaveProperty(key);
    }
    expectFull(emit(action(), { sessionUuid: "s2" }));
    expectFull(emit(action("phone-b")));
    expectFull(emit());
  });
  test.each(["environment", "feature-flag"])(
    "%s opt-out restores every block and duplicate element",
    (source) => {
      if (source === "environment") {
        serverConfig.setActionsCompactMetadataEnabled(
          parseOutputReductionFlags([], {
            AUTOMOBILE_ACTIONS_COMPACT_METADATA: "0",
          }).actionsCompactMetadata,
        );
      } else {
        new DefaultFeatureFlagApplier().apply("actions-compact-metadata", false);
      }
      for (let i = 0; i < 2; i++) {
        const response = emit();
        expectFull(response);
        expect(structuredPayload(response).element).toEqual(element);
      }
      expect(records.size).toBe(0);
    },
  );
  test("first full; identical second omits each block; changed block alone reappears", () => {
    expectFull(emit());
    const repeated = observation(emit());
    for (const key of Object.keys(metadata)) {
      expect(repeated).not.toHaveProperty(key);
    }
    const changed = action();
    (changed.observation as Record<string, unknown>).gfxMetrics = { isStable: true, frameCount: 2 };
    expect(observation(emit(changed)).gfxMetrics).toEqual({ isStable: true, frameCount: 2 });
    expect(observation(emit(changed))).not.toHaveProperty("gfxMetrics");
    expect(observation(emit())).not.toHaveProperty("insets");
  });
  test("a response that is not delivered records no snapshot, so the next response still carries every block (#10081)", () => {
    expectFull(emit(action(), { delivered: false }));
    expect(records.size).toBe(0);
    expectFull(emit());
    expect(records.get("s1")?.deviceId).toBe("phone-a");
    for (const key of Object.keys(metadata)) {
      expect(observation(emit())).not.toHaveProperty(key);
    }
  });
  test("a discarded response is still compacted against the last delivered snapshot but does not replace it (#10081)", () => {
    emit();
    const changed = action();
    (changed.observation as Record<string, unknown>).deviceLock = { isLocked: true };
    const discarded = observation(emit(changed, { delivered: false }));
    expect(discarded.deviceLock).toEqual({ isLocked: true });
    expect(records.get("s1")?.blocks.deviceLock).toEqual({ isLocked: false });
    // The client never saw isLocked:true, so the unlocked state is the one it holds.
    expect(observation(emit())).not.toHaveProperty("deviceLock");
    expect(observation(emit(changed))).toHaveProperty("deviceLock");
  });
  test("new session and every device switch resend all blocks, including return to the first device", () => {
    emit();
    expectFull(emit(action(), { sessionUuid: "s2" }));
    expectFull(emit(action("phone-b")));
    expectFull(emit());
  });
  test("missing device identity emits full and records nothing", () => {
    const payload = action();
    delete (payload.observation as Record<string, unknown>).deviceId;
    expectFull(emit(payload));
    expectFull(emit(payload));
    expect(records.size).toBe(0);
  });
  test("identical duplicate element omitted; differing or absent match retained", () => {
    expect(structuredPayload(emit())).not.toHaveProperty("element");
    const different = action();
    different.element = { ...element, text: "Different" };
    expect(structuredPayload(emit(different)).element).toEqual(different.element);
    const absent = action();
    delete absent.selectedElement;
    expect(structuredPayload(emit(absent)).element).toEqual(element);
  });
  test("required element stays present", () => {
    expect(
      structuredPayload(
        emit(action(), { outputSchema: z.object({ element: z.object({ text: z.string() }) }) }),
      ).element,
    ).toEqual(element);
  });
  test("observe never omits and records the top-level metadata it sends", () => {
    const payload = action().observation as Record<string, unknown>;
    for (let i = 0; i < 2; i++) {
      const result = structuredPayload(emit(payload, { name: "observe" }));
      for (const key of Object.keys(metadata)) {
        expect(result).toHaveProperty(key);
      }
    }
    expect(records.get("s1")?.blocks).toEqual(metadata);
    expect(observation(emit())).not.toHaveProperty("insets");
  });
  test("internal calls neither omit nor record, even with a previous external response", () => {
    expectFull(emit(action(), { internal: true }));
    expect(records.size).toBe(0);
    emit();
    const internal = emit(action(), { internal: true });
    expectFull(internal);
    expect(structuredPayload(internal).element).toEqual(element);
  });
  test("failure payload and MCP isError never omit but record inline metadata", () => {
    emit();
    const failed = action();
    failed.success = false;
    (failed.observation as Record<string, unknown>).gfxMetrics = { isStable: false };
    expectFull(emit(failed));
    expect(structuredPayload(emit(failed)).element).toEqual(element);
    const error = createStructuredToolResponse(action());
    Object.assign(error, { isError: true });
    finalizeToolResponse(error, { name: "tapOn", sessionUuid: "fresh", baselineStore: store });
    expect(records.get("fresh")?.blocks).toEqual(metadata);
    expect(observation(emit()).gfxMetrics).toEqual(metadata.gfxMetrics);
    expect(structuredPayload(emit({ success: false, error: "failed" }))).toEqual({
      success: false,
      error: "failed",
    });
  });
  test("actions-no-observe records no metadata but still removes duplicate element", () => {
    serverConfig.setActionsNoObserveEnabled(true);
    const result = structuredPayload(emit());
    expect(result).not.toHaveProperty("observation");
    expect(result).not.toHaveProperty("element");
    expect(records.get("s1")?.blocks).toEqual({});
    serverConfig.setActionsNoObserveEnabled(false);
    expectFull(emit());
  });
  test("diff passthrough freshness is compacted without changing the hierarchy baseline", () => {
    serverConfig.setActionsDiffObserveEnabled(true);
    emit();
    const repeated = observation(emit());
    expect(repeated.isDiff).toBe(true);
    expect(repeated).not.toHaveProperty("freshness");
    expect(baselines.get("s1")?.freshness).toEqual(metadata.freshness);
    const changed = action();
    (changed.observation as Record<string, unknown>).freshness = { verified: true, isFresh: false };
    expect(observation(emit(changed)).freshness).toEqual({ verified: true, isFresh: false });
  });
  test("raw hierarchy inset copies compact independently", () => {
    const payload = action();
    const obs = payload.observation as ObserveResult;
    obs.viewHierarchy!.systemInsets = { top: 4, bottom: 0, left: 0, right: 0 };
    const context = { args: { raw: true } };
    const first = observation(emit(payload, context));
    expect(first.viewHierarchy).toHaveProperty("systemInsets");
    expect(observation(emit(payload, context)).viewHierarchy).not.toHaveProperty("systemInsets");
    obs.viewHierarchy!.systemInsets.top = 6;
    expect(
      (observation(emit(payload, context)).viewHierarchy as Record<string, unknown>).systemInsets,
    ).toEqual({ top: 6, bottom: 0, left: 0, right: 0 });
  });
  test("artifact-only observation does not prime metadata state", () => {
    emit(action(), { artifactWriter: new FakeObservationArtifactWriter() });
    expect(records.get("s1")?.blocks).toEqual({});
    expectFull(emit());
  });
  test("oversized residue does not record blocks removed from inline output", () => {
    const payload = action();
    payload.large = "x".repeat(DEFAULT_OBSERVATION_INLINE_MAX_BYTES);
    const result = emit(payload, {
      artifactWriter: new FakeObservationArtifactWriter(),
      artifactMode: "oversized",
    });
    expect(structuredPayload(result)).toHaveProperty("artifact");
    expect(records.get("s1")?.blocks).toEqual({});
    expectFull(emit());
  });
  test("snapshot is detached from caller mutations and omitted blocks stay last-sent", () => {
    const payload = action();
    emit(payload);
    (payload.observation as Record<string, unknown>).systemInsets = {
      top: 99,
      bottom: 0,
      left: 0,
      right: 0,
    };
    expect(observation(emit(payload)).systemInsets).toEqual({
      top: 99,
      bottom: 0,
      left: 0,
      right: 0,
    });
    const missing = action();
    delete (missing.observation as Record<string, unknown>).systemInsets;
    emit(missing);
    expect(observation(emit(payload))).not.toHaveProperty("systemInsets");
  });
  test("device switches with stripped or spilled metadata still invalidate the previous device", () => {
    emit();
    serverConfig.setActionsNoObserveEnabled(true);
    emit(action("phone-b"));
    serverConfig.setActionsNoObserveEnabled(false);
    expectFull(emit());
    const spilled = action("phone-b");
    spilled.large = "x".repeat(DEFAULT_OBSERVATION_INLINE_MAX_BYTES);
    emit(spilled, {
      artifactWriter: new FakeObservationArtifactWriter(),
      artifactMode: "oversized",
    });
    expectFull(emit());
  });
  test("diff-body artifact records only metadata retained inline", () => {
    serverConfig.setActionsDiffObserveEnabled(true);
    const writer = new FakeObservationArtifactWriter();
    emit(action(), { artifactWriter: writer });
    expect(records.get("s1")?.blocks).toEqual({});
    const second = observation(emit(action(), { artifactWriter: writer }));
    expect(second).toHaveProperty("freshness");
    expect(second).toHaveProperty("artifact");
    expect(records.get("s1")?.blocks).toEqual({ freshness: metadata.freshness });
    expect(observation(emit(action(), { artifactWriter: writer }))).not.toHaveProperty("freshness");
    expectFull(emit(action(), { args: { raw: true }, sessionUuid: "new-session" }));
  });
  test("failed changed metadata is recorded for the next successful response", () => {
    emit();
    const changed = action();
    (changed.observation as Record<string, unknown>).insets = {
      ...metadata.insets,
      reason: "changed",
    };
    emit({ ...changed, success: false });
    expect(records.get("s1")?.blocks.insets).toEqual({ ...metadata.insets, reason: "changed" });
    expect(observation(emit(changed))).not.toHaveProperty("insets");
  });

  test.each([
    [
      "executePlan",
      {
        success: true,
        failedStep: { failureObservation: makeObserveResult() },
        deviceFailures: [{ failureObservation: makeObserveResult() }],
        debug: { steps: [{ details: { stepObservation: makeObserveResult() } }] },
      },
    ],
    ["getNetworkGraph", { success: true, graph: [{ host: "example.test" }] }],
  ] as const)("%s always artifacts identically with compaction on or off", (name, payload) => {
    const offWriter = new FakeObservationArtifactWriter();
    serverConfig.setActionsCompactMetadataEnabled(false);
    const expected = emit(payload, { name, artifactWriter: offWriter, artifactMode: "always" });
    const onWriter = new FakeObservationArtifactWriter();
    serverConfig.setActionsCompactMetadataEnabled(true);
    const actual = emit(payload, { name, artifactWriter: onWriter, artifactMode: "always" });
    expect(onWriter.writes.length).toBeGreaterThan(0);
    expect(onWriter.writes).toEqual(offWriter.writes);
    expect(actual).toEqual(expected);
  });

  test.each([
    { success: true },
    { success: true, observation: { deviceId: "phone-a", insets: metadata.insets } },
  ])(
    "no-op compaction preserves payload identity and the original envelope text: %j",
    (payload) => {
      // No ObserveResult marker: finalization can return this exact envelope unchanged.
      const response = createStructuredToolResponse(payload);
      const originalText = JSON.stringify(payload, null, 2);
      response.content[0].text = originalText;
      const textPart = response.content[0];
      expect(
        finalizeToolResponse(response, {
          name: "customAction",
          sessionUuid: "s1",
          baselineStore: store,
        }),
      ).toBe(response);
      expect(response.structuredContent).toBe(payload);
      expect(response.content[0]).toBe(textPart);
      expect(response.content[0].text).toBe(originalText);
    },
  );

  test.each(["full", "skeleton", "early-return", "text-only"])(
    "observe %s updates last-sent insets before the next action",
    (mode) => {
      emit();
      const insetsB = { ...metadata.insets, reason: "keyboard shown" };
      const payload =
        mode === "early-return"
          ? { deviceId: "phone-a", insets: insetsB }
          : { ...makeObserveResult(), deviceId: "phone-a", insets: insetsB };
      const ctx = {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
        args: { project: mode === "skeleton" ? "skeleton" : "full" },
      };
      if (mode === "text-only") {
        const response = { content: [{ type: "text", text: stringifyToolResponse(payload) }] };
        finalizeToolResponse(response, ctx);
        expect(JSON.parse(response.content[0].text).insets).toEqual(insetsB);
      } else {
        expect(structuredPayload(emit(payload, ctx)).insets).toEqual(insetsB);
      }
      expect(records.get("s1")?.blocks.insets).toEqual(insetsB);
      expect(observation(emit()).insets).toEqual(metadata.insets);
    },
  );

  test.each(["success-false", "payload-error", "isError"])(
    "%s records carried blocks and leaves absent blocks alone",
    (kind) => {
      emit();
      const insetsB = { ...metadata.insets, reason: "error capture" };
      const payload = action();
      const obs = payload.observation as Record<string, unknown>;
      obs.insets = insetsB;
      delete obs.systemInsets;
      if (kind === "success-false") {
        payload.success = false;
      }
      if (kind === "payload-error") {
        payload.error = "failed";
      }
      const response = createStructuredToolResponse(payload);
      if (kind === "isError") {
        Object.assign(response, { isError: true });
      }
      finalizeToolResponse(response, { name: "tapOn", sessionUuid: "s1", baselineStore: store });
      expect(structuredPayload(response).element).toEqual(element);
      expect(observation(response).insets).toEqual(insetsB);
      expect(records.get("s1")?.blocks.insets).toEqual(insetsB);
      expect(records.get("s1")?.blocks.systemInsets).toEqual(metadata.systemInsets);
      const snapshot = records.get("s1");
      emit({ success: false, error: "no capture" });
      expect(records.get("s1")).toBe(snapshot);
      expect(observation(emit()).insets).toEqual(metadata.insets);
    },
  );

  test.each([
    ["freshness", { verified: false, isFresh: false, warning: "no capture timestamp" }],
    ["freshness", { verified: false, warning: "freshness unknown" }],
    ["gfxMetrics", { isStable: false }],
  ] as const)("repeated warning block %s %j always stays inline and recorded", (field, block) => {
    const payload = action();
    (payload.observation as Record<string, unknown>)[field] = block;
    for (let i = 0; i < 2; i++) {
      expect(observation(emit(payload))[field]).toEqual(block);
      expect(records.get("s1")?.blocks[field]).toEqual(block);
    }
  });

  test.each(["observation", "oversized-residue"])(
    "%s artifact retains uncompacted metadata and does not record artifact-only changes",
    (mode) => {
      emit();
      const payload = action();
      if (mode === "oversized-residue") {
        // No ObserveResult marker: exercise the whole-payload ceiling spill directly.
        payload.observation = {
          deviceId: "phone-a",
          insets: metadata.insets,
          deviceLock: { isLocked: true },
        };
      }
      const obs = payload.observation as Record<string, unknown>;
      const changedField = mode === "observation" ? "systemInsets" : "deviceLock";
      if (mode === "observation") {
        obs.systemInsets = { ...metadata.systemInsets, top: 99 };
      }
      const writer = new FakeObservationArtifactWriter();
      if (mode === "oversized-residue") {
        payload.large = "x".repeat(DEFAULT_OBSERVATION_INLINE_MAX_BYTES);
      }
      const result = emit(payload, {
        artifactWriter: writer,
        artifactMode: mode === "observation" ? "always" : "oversized",
      });
      expect(writer.writes).toHaveLength(1);
      const written = JSON.parse(writer.writes[0].serialized!);
      const writtenObs = mode === "observation" ? written : written.observation;
      expect(writtenObs.insets).toEqual(metadata.insets);
      expect(writtenObs[changedField]).toEqual(obs[changedField]);
      if (mode === "oversized-residue") {
        expect(written.element).toEqual(element);
      }
      const inline = structuredPayload(result);
      expect(mode === "observation" ? inline.observation : inline).toHaveProperty("artifact");
      expect(records.get("s1")?.blocks).toEqual(metadata);
      expect(observation(emit(payload))[changedField]).toEqual(obs[changedField]);
    },
  );

  test("artifacted observe carries no metadata inline and leaves last-sent blocks alone", () => {
    emit();
    const payload = {
      ...makeObserveResult(),
      deviceId: "phone-a",
      insets: { ...metadata.insets, reason: "only in artifact" },
    };
    const result = emit(payload, {
      name: "observe",
      artifactWriter: new FakeObservationArtifactWriter(),
    });
    expect(structuredPayload(result)).toHaveProperty("artifact");
    expect(structuredPayload(result)).not.toHaveProperty("insets");
    expect(records.get("s1")?.blocks).toEqual(metadata);
    expect(observation(emit())).not.toHaveProperty("insets");
  });

  // Real consecutive tapOn blocks captured on emulator-5600 (#9886): the back stack
  // differs between the two calls only in capturedAt.
  function realAction(which: "first" | "second", blocks: Record<string, unknown> = {}) {
    return {
      success: true,
      observation: { ...makeObserveResult(), ...structuredClone(realTapOns[which]), ...blocks },
    };
  }

  test("real consecutive Android taps omit backStack that differs only in capturedAt", () => {
    expect(realTapOns.first.backStack.capturedAt).not.toBe(realTapOns.second.backStack.capturedAt);
    expect(observation(emit(realAction("first")))).toHaveProperty("backStack");
    const second = observation(emit(realAction("second")));
    expect(second).not.toHaveProperty("backStack");
    // The baseline stays what the client last received, so the next change still compares.
    expect(records.get("s1")?.blocks.backStack).toEqual(realTapOns.first.backStack);
  });
  test("real consecutive Android taps still send freshness and gfxMetrics", () => {
    emit(realAction("first"));
    const second = observation(emit(realAction("second")));
    expect(second.freshness).toEqual(realTapOns.second.freshness);
    expect(second.gfxMetrics).toEqual(realTapOns.second.gfxMetrics);
  });
  test("a different top activity sends backStack in full with the new capturedAt", () => {
    emit(realAction("first"));
    const moved = structuredClone(realTapOns.second.backStack);
    moved.currentActivity.name = "dev.jasonpearson.automobile.playground.OtherActivity";
    moved.activities[0].name = moved.currentActivity.name;
    const sent = observation(emit(realAction("second", { backStack: moved }))).backStack;
    expect(sent).toEqual(moved);
    expect((sent as { capturedAt: number }).capturedAt).toBe(
      realTapOns.second.backStack.capturedAt,
    );
  });
  test("a partial backStack is always sent even when only capturedAt differs", () => {
    const partial = (capturedAt: number) => ({
      depth: 0,
      activities: [],
      tasks: [],
      capturedAt,
      partial: true,
      source: "adb",
    });
    emit(realAction("first", { backStack: partial(1) }));
    expect(observation(emit(realAction("second", { backStack: partial(2) }))).backStack).toEqual(
      partial(2),
    );
  });
  test("in-memory undefined keys compare in wire form against the recorded baseline", () => {
    // A bare observation skips ObserveResult shaping, so the undefined keys reach the comparison.
    const bare = () => ({
      success: true,
      observation: {
        deviceId: realTapOns.first.deviceId,
        backStack: {
          ...structuredClone(realTapOns.first.backStack),
          displayCount: undefined,
          currentActivity: undefined,
        },
      },
    });
    emit(bare());
    expect(observation(emit(bare()))).not.toHaveProperty("backStack");
  });
  test("flag off leaves real consecutive responses byte-identical and records nothing", () => {
    serverConfig.setActionsCompactMetadataEnabled(false);
    const bytes = (payload: Record<string, unknown>) => JSON.stringify(emit(payload));
    const withoutStore = (payload: Record<string, unknown>) =>
      JSON.stringify(emit(payload, { baselineStore: undefined }));
    expect(bytes(realAction("first"))).toBe(withoutStore(realAction("first")));
    expect(bytes(realAction("second"))).toBe(withoutStore(realAction("second")));
    expect(observation(emit(realAction("second"))).backStack).toEqual(realTapOns.second.backStack);
    expect(records.size).toBe(0);
  });
});
