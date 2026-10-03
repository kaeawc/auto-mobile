import { afterEach, describe, expect, test } from "bun:test";
import {
  finalizeToolResponse,
  type ObservationArtifactWriteInput,
  type ObservationArtifactWriter,
} from "../../src/server/finalizeToolResponse";
import type { ObserveResult } from "../../src/models/ObserveResult";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { serverConfig } from "../../src/utils/ServerConfig";

class FakeArtifactWriter implements ObservationArtifactWriter {
  readonly contents: string[] = [];

  writeJsonArtifact(input: ObservationArtifactWriteInput) {
    const content = input.serialized ?? JSON.stringify(input.data);
    this.contents.push(content);
    return {
      artifact: {
        path: "/fixture/tool-output.json",
        format: "json" as const,
        payload: input.payload,
        bytes: Buffer.byteLength(content, "utf8"),
        tool: input.tool,
        resourceUri: "automobile:tool-output/fixture",
      },
    };
  }
}

function observation(text = "Run"): ObserveResult {
  return {
    updatedAt: 123,
    screenSize: { width: 100, height: 200 },
    activeWindow: { appId: "example.app", activityName: ".Main", layoutSeqSum: 1 },
    screenshot: "fixture-base64",
    screenshotPath: "/fixture/screenshot.png",
    viewHierarchy: {
      packageName: "example.app",
      hierarchy: {
        node: {
          "resource-id": "example.app:id/root",
          text,
          extras: { diagnostic: "kept in artifact" },
          bounds: { left: 0, top: 0, right: 100, bottom: 200 },
        },
      },
    },
  } as ObserveResult;
}

function capture(payload: Record<string, unknown>, name: string, mode: "always" | "oversized") {
  const writer = new FakeArtifactWriter();
  const response = finalizeToolResponse(createStructuredToolResponse(payload), {
    name,
    args: { project: "full" },
    artifactWriter: writer,
    artifactMode: mode,
  });
  return { wire: response.content.map((part) => part.text), artifacts: writer.contents };
}

describe("finalizeToolResponse serialization bytes", () => {
  const originalDiff = serverConfig.isActionsDiffObserveEnabled();
  afterEach(() => serverConfig.setActionsDiffObserveEnabled(originalDiff));

  test("small inline payload", () => {
    expect(
      capture({ success: true, text: "héllo", extras: { detail: 1 } }, "fixture", "oversized"),
    ).toMatchSnapshot();
  });

  test("oversized payload preserves complete artifact bytes", () => {
    expect(
      capture({ success: true, extras: { pad: "é".repeat(33_000) } }, "fixture", "oversized"),
    ).toMatchSnapshot();
  });

  test("reuses each rendering for the size probe and artifact writer", () => {
    let inlineAndCompleteCalls = 0;
    let extrasCalls = 0;
    const response = createStructuredToolResponse({
      success: true,
      value: {
        toJSON: () => {
          inlineAndCompleteCalls += 1;
          return "headline";
        },
      },
      extras: {
        toJSON: () => {
          extrasCalls += 1;
          return { pad: "é".repeat(33_000) };
        },
      },
    });
    // Handler serialization precedes this finalization boundary.
    inlineAndCompleteCalls = 0;
    extrasCalls = 0;
    const writer = new FakeArtifactWriter();
    finalizeToolResponse(response, {
      name: "fixture",
      artifactWriter: writer,
      artifactMode: "oversized",
    });
    expect(writer.contents).toHaveLength(1);
    expect(inlineAndCompleteCalls).toBe(2); // One stripped and one complete rendering.
    // JSON invokes toJSON before the inline replacer drops extras.
    expect(extrasCalls).toBe(2);
  });

  test("reuses the inline size rendering as wire text", () => {
    let calls = 0;
    const response = createStructuredToolResponse({
      success: true,
      headline: {
        toJSON: () => {
          calls += 1;
          return "headline";
        },
      },
      observation: observation(),
    });
    calls = 0;
    const writer = new FakeArtifactWriter();
    const finalized = finalizeToolResponse(response, {
      name: "tapOn",
      args: { project: "full" },
      artifactWriter: writer,
      artifactMode: "oversized",
    });
    expect(writer.contents).toHaveLength(0);
    expect(finalized.content[0].text).toContain('"headline":"headline"');
    expect(calls).toBe(2); // One stripped and one complete rendering, with no wire re-render.
  });

  test("observation screenshot and hierarchy", () => {
    expect(capture(observation(), "observe", "always")).toMatchSnapshot();
  });

  test.each(["full", "skeleton"])("action diff with %s projection", (project) => {
    serverConfig.setActionsDiffObserveEnabled(true);
    const baselines = new Map<string, ObserveResult>();
    const baselineStore = {
      get: (id: string) => baselines.get(id),
      set: (id: string, value: ObserveResult) => {
        baselines.set(id, value);
      },
    };
    finalizeToolResponse(createStructuredToolResponse(observation()), {
      name: "observe",
      args: { project: "full" },
      sessionUuid: "fixture",
      baselineStore,
    });
    const writer = new FakeArtifactWriter();
    const response = finalizeToolResponse(
      createStructuredToolResponse({ success: true, observation: observation("Done") }),
      {
        name: "tapOn",
        args: { project },
        sessionUuid: "fixture",
        baselineStore,
        artifactWriter: writer,
      },
    );
    expect({
      wire: response.content.map((part) => part.text),
      artifacts: writer.contents,
    }).toMatchSnapshot();
  });
});
