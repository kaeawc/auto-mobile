import { describe, expect, test } from "bun:test";
import {
  finalizeToolResponse,
  type ObservationArtifactMetadata,
  type ObservationArtifactWriter,
  type ObservationArtifactWriteInput,
} from "../../src/server/finalizeToolResponse";
import { artifactResourceLinks } from "../../src/server/finalizeToolResponse/artifactResourceLinks";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";

class FakeWriter implements ObservationArtifactWriter {
  writeJsonArtifact(input: ObservationArtifactWriteInput): ObservationArtifactMetadata {
    return {
      artifact: {
        path: "/tmp/x.json",
        format: "json",
        payload: "ToolResponse",
        bytes: 99000,
        tool: input.tool,
        resourceUri: "automobile:tool-output/1-getLogs-a.json",
      },
    };
  }
}

const oversized = () =>
  createStructuredToolResponse({ success: true, logs: "x".repeat(70 * 1024) });

describe("artifact resource_link blocks (#13942)", () => {
  test("a spilled response carries a resource_link beside the artifact pointer", () => {
    const response = finalizeToolResponse(oversized(), {
      name: "getLogs",
      artifactWriter: new FakeWriter(),
    }) as { content: Array<Record<string, unknown>> };

    expect(response.content.filter((part) => part.type === "resource_link")).toEqual([
      {
        type: "resource_link",
        uri: "automobile:tool-output/1-getLogs-a.json",
        name: "getLogs full response",
        mimeType: "application/json",
        size: 99000,
      },
    ]);
    expect(response.content[0]!.type).toBe("text");
    expect(String(response.content[0]!.text)).toContain("automobile:tool-output/1-getLogs-a.json");
  });

  test("a small response and an internal caller get no link", () => {
    const small = finalizeToolResponse(createStructuredToolResponse({ success: true }), {
      name: "getLogs",
      artifactWriter: new FakeWriter(),
    }) as { content: Array<Record<string, unknown>> };
    const internal = finalizeToolResponse(oversized(), {
      name: "getLogs",
      artifactWriter: new FakeWriter(),
      internal: true,
    }) as { content: Array<Record<string, unknown>> };

    expect(small.content.some((part) => part.type === "resource_link")).toBe(false);
    expect(internal.content.some((part) => part.type === "resource_link")).toBe(false);
  });

  test("only a whole-response spill is linked, never an observation artifact", () => {
    const pointer = (payload: string) => ({
      artifact: { resourceUri: "automobile:tool-output/1-a.json", bytes: 5, tool: "t", payload },
    });

    expect(artifactResourceLinks(pointer("ToolResponse"))).toHaveLength(1);
    expect(artifactResourceLinks(pointer("ObserveResult"))).toEqual([]);
    expect(artifactResourceLinks({ observation: pointer("ToolResponse") })).toEqual([]);
    expect(artifactResourceLinks({ artifact: { path: "/x" } })).toEqual([]);
  });
});
