import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  finalizeToolResponse,
  type ObservationArtifactWriteInput,
} from "../../src/server/finalizeToolResponse";
import { serverConfig } from "../../src/utils/ServerConfig";
import {
  createStructuredToolResponse,
  getStructuredPayload,
  stringifyToolResponse,
} from "../../src/utils/toolUtils";
import type { ObserveResult } from "../../src/models/ObserveResult";

function observation(checked = false): ObserveResult {
  return {
    updatedAt: 123,
    screenSize: { width: 100, height: 200 },
    activeWindow: { appId: "example.app", activityName: ".Main", layoutSeqSum: 1 },
    viewHierarchy: {
      packageName: "example.app",
      hierarchy: {
        node: {
          "resource-id": "example.app:id/root",
          "view-id": "example.app:id/root",
          bounds: { left: 0, top: 0, right: 100, bottom: 200 },
          node: [
            {
              "resource-id": "example.app:id/button",
              text: "Run",
              checked: checked ? "true" : "false",
              bounds: { left: 10, top: 20, right: 50, bottom: 50 },
            },
          ],
        },
      },
    },
    elements: {
      clickable: [
        {
          "resource-id": "example.app:id/button",
          text: "Run",
          clickable: "true",
          bounds: { left: 10, top: 20, right: 50, bottom: 50 },
        },
      ],
      scrollable: [],
      text: [],
      media: [],
    },
  } as ObserveResult;
}

function wire(response: { content: Array<{ text: string }> }): string {
  return response.content[0].text;
}

describe("finalizeToolResponse serialized shape compatibility", () => {
  const originalDiff = serverConfig.isActionsDiffObserveEnabled();
  afterEach(() => serverConfig.setActionsDiffObserveEnabled(originalDiff));

  test("full", () => {
    expect(
      wire(
        finalizeToolResponse(createStructuredToolResponse(observation()), {
          name: "observe",
          args: { project: "full" },
        }),
      ),
    ).toMatchSnapshot();
  });

  test("overview summary", () => {
    expect(
      wire(
        finalizeToolResponse(createStructuredToolResponse(observation()), {
          name: "observe",
          args: { project: "full", scope: { overview: true } },
        }),
      ),
    ).toMatchSnapshot();
  });

  test("skeleton", () => {
    expect(
      wire(
        finalizeToolResponse(createStructuredToolResponse(observation()), {
          name: "observe",
          args: { project: "skeleton" },
        }),
      ),
    ).toMatchSnapshot();
  });

  test("skeleton does not recollect intentionally empty element categories", () => {
    const source = observation();
    source.elements = { clickable: [], scrollable: [], text: [], media: [] };
    const before = JSON.stringify(source);
    const response = finalizeToolResponse(createStructuredToolResponse(source), {
      name: "observe",
      args: { project: "skeleton" },
    });
    const payload = JSON.parse(wire(response)) as ObserveResult;
    expect(payload.skeleton).toEqual([]);
    expect(payload.context).toBeUndefined();
    expect(JSON.stringify(source)).toBe(before);
  });

  test("diff with full projection", () => {
    serverConfig.setActionsDiffObserveEnabled(true);
    const baseline = new Map<string, ObserveResult>();
    const store = {
      get: (id: string) => baseline.get(id),
      set: (id: string, value: ObserveResult) => {
        baseline.set(id, value);
      },
    };
    finalizeToolResponse(createStructuredToolResponse(observation()), {
      name: "observe",
      args: { project: "full" },
      sessionUuid: "fixture",
      baselineStore: store,
    });
    expect(
      wire(
        finalizeToolResponse(
          createStructuredToolResponse({ success: true, observation: observation(true) }),
          {
            name: "tapOn",
            args: { raw: true },
            sessionUuid: "fixture",
            baselineStore: store,
          },
        ),
      ),
    ).toMatchSnapshot();
  });

  test("oversized spill", () => {
    const writes: ObservationArtifactWriteInput[] = [];
    const writer = {
      writeJsonArtifact(input: ObservationArtifactWriteInput) {
        writes.push(input);
        return {
          artifact: {
            path: "/tmp/fixture.json",
            format: "json" as const,
            payload: input.payload,
            bytes: Buffer.byteLength(stringifyToolResponse(input.data)),
            tool: input.tool,
            resourceUri: "automobile:tool-output/fixture",
          },
        };
      },
    };
    const result = finalizeToolResponse(
      createStructuredToolResponse({
        success: true,
        pad: "x".repeat(70_000),
        observation: observation(),
      }),
      {
        name: "tapOn",
        args: { project: "full" },
        artifactWriter: writer,
        artifactMode: "oversized",
      },
    );
    expect({
      inline: wire(result),
      writes: writes.map((input) => ({
        tool: input.tool,
        payload: input.payload,
        sha256: createHash("sha256").update(stringifyToolResponse(input.data)).digest("hex"),
      })),
    }).toMatchSnapshot();
  });
});

describe("finalizeToolResponse observation clone boundary", () => {
  const originalDiff = serverConfig.isActionsDiffObserveEnabled();
  afterEach(() => serverConfig.setActionsDiffObserveEnabled(originalDiff));

  test("keeps a no-op scoped output separate from the diff baseline", () => {
    serverConfig.setActionsDiffObserveEnabled(true);
    let baseline: ObserveResult | undefined;
    const result = finalizeToolResponse(createStructuredToolResponse(observation()), {
      name: "observe",
      args: { project: "full" },
      sessionUuid: "fixture",
      baselineStore: {
        get: () => baseline,
        set: (_id, value) => {
          baseline = value;
        },
      },
    });
    expect(baseline).toBeDefined();
    expect(baseline).not.toBe(getStructuredPayload(result));
  });

  test.each([
    { label: "full", args: { project: "full" } },
    { label: "overview", args: { project: "full", scope: { overview: true } } },
    { label: "skeleton", args: { project: "skeleton" } },
  ])("clones once for observe $label", ({ args }) => {
    let clones = 0;
    finalizeToolResponse(createStructuredToolResponse(observation()), {
      name: "observe",
      args,
      cloneObservation: (source) => {
        clones += 1;
        return JSON.parse(JSON.stringify(source)) as ObserveResult;
      },
    });
    expect(clones).toBe(1);
  });

  test.each([{ raw: true }, { project: "skeleton" }])(
    "clones once for an emitted action diff with %p",
    (args) => {
      serverConfig.setActionsDiffObserveEnabled(true);
      const baseline = new Map<string, ObserveResult>();
      const store = {
        get: (id: string) => baseline.get(id),
        set: (id: string, value: ObserveResult) => {
          baseline.set(id, value);
        },
      };
      finalizeToolResponse(createStructuredToolResponse(observation()), {
        name: "observe",
        sessionUuid: "fixture",
        baselineStore: store,
      });
      let clones = 0;
      const result = finalizeToolResponse(
        createStructuredToolResponse({
          success: true,
          observation: observation(true),
        }),
        {
          name: "tapOn",
          args,
          sessionUuid: "fixture",
          baselineStore: store,
          cloneObservation: (source) => {
            clones += 1;
            return JSON.parse(JSON.stringify(source)) as ObserveResult;
          },
        },
      );
      expect(JSON.parse(wire(result)).observationDiff.mode).toBe("diff");
      expect(clones).toBe(1);
    },
  );
});
