import { describe, expect, test } from "bun:test";
import type { ObservationArtifactWriter } from "../../src/server/finalizeToolResponse";

/**
 * Shared behavioural contract for {@link ObservationArtifactWriter} (#11868). Run against the fake
 * and the real JsonToolOutputArtifactWriter. File names are deliberately not pinned (the real one
 * embeds a timestamp and uuid); the contract covers what consumers of the metadata rely on.
 */
export const runObservationArtifactWriterContract = (
  description: string,
  make: () => ObservationArtifactWriter,
): void => {
  describe(`ObservationArtifactWriter contract: ${description}`, () => {
    test("echoes tool, payload kind and json format", () => {
      const { artifact } = make().writeJsonArtifact({
        tool: "observe",
        payload: "observation",
        data: { a: 1 },
      });

      expect(artifact.tool).toBe("observe");
      expect(artifact.payload).toBe("observation");
      expect(artifact.format).toBe("json");
    });

    test("reports the byte length of the JSON-serialized data", () => {
      const data = { text: "héllo \u{1F600}", n: [1, 2, 3] };

      const { artifact } = make().writeJsonArtifact({ tool: "observe", payload: "p", data });

      expect(artifact.bytes).toBe(Buffer.byteLength(JSON.stringify(data), "utf8"));
    });

    test("an explicit serialized rendering is what is measured", () => {
      const data = { a: 1 };
      const serialized = JSON.stringify(data, null, 2);

      const { artifact } = make().writeJsonArtifact({
        tool: "observe",
        payload: "p",
        data,
        serialized,
      });

      expect(artifact.bytes).toBe(Buffer.byteLength(serialized, "utf8"));
    });

    test("path is a .json file named for the tool and the resource uri addresses the same file", () => {
      const { artifact } = make().writeJsonArtifact({ tool: "observe", payload: "p", data: {} });

      const basename = artifact.path.split(/[\\/]/).pop() ?? "";
      expect(basename.endsWith(".json")).toBe(true);
      expect(basename).toContain("observe");
      expect(artifact.resourceUri).toBe(`automobile:tool-output/${basename}`);
    });

    test("each write gets its own path and uri", () => {
      const writer = make();

      const first = writer.writeJsonArtifact({ tool: "observe", payload: "p", data: {} });
      const second = writer.writeJsonArtifact({ tool: "observe", payload: "p", data: {} });

      expect(second.artifact.path).not.toBe(first.artifact.path);
      expect(second.artifact.resourceUri).not.toBe(first.artifact.resourceUri);
    });
  });
};
