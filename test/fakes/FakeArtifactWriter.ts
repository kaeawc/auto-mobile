import path from "node:path";
import type {
  ObservationArtifactMetadata,
  ObservationArtifactWriteInput,
  ObservationArtifactWriter,
} from "../../src/server/finalizeToolResponse";

const FAKE_OUTPUT_DIR = "/tmp/auto-mobile/tool-outputs";

export class FakeArtifactWriter implements ObservationArtifactWriter {
  readonly writes: ObservationArtifactWriteInput[] = [];
  throwOnWrite: Error | undefined;
  private nextId = 1;

  writeJsonArtifact(input: ObservationArtifactWriteInput): ObservationArtifactMetadata {
    if (this.throwOnWrite) {
      throw this.throwOnWrite;
    }
    this.writes.push(input);
    // Same persisted-bytes rule as JsonToolOutputArtifactWriter: an explicit
    // `serialized` rendering wins, otherwise plain JSON.stringify(data) (#11868).
    const content = input.serialized ?? JSON.stringify(input.data);
    const filename = `${input.tool}-${this.nextId++}.json`;
    return {
      artifact: {
        path: path.posix.join(FAKE_OUTPUT_DIR, filename),
        format: "json",
        payload: input.payload,
        bytes: Buffer.byteLength(content, "utf8"),
        tool: input.tool,
        resourceUri: `automobile:tool-output/${filename}`,
      },
    };
  }
}
