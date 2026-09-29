import type {
  ObservationArtifactMetadata,
  ObservationArtifactWriteInput,
  ObservationArtifactWriter,
} from "../../src/server/finalizeToolResponse";

export class FakeArtifactWriter implements ObservationArtifactWriter {
  readonly writes: ObservationArtifactWriteInput[] = [];
  throwOnWrite: Error | undefined;

  writeJsonArtifact(input: ObservationArtifactWriteInput): ObservationArtifactMetadata {
    if (this.throwOnWrite) {
      throw this.throwOnWrite;
    }
    this.writes.push(input);
    return {
      artifact: {
        path: `/tmp/auto-mobile/tool-outputs/${input.tool}-1.json`,
        format: "json",
        payload: input.payload,
        bytes: 99_999,
        tool: input.tool,
        resourceUri: `automobile:tool-output/${input.tool}-1.json`,
      },
    };
  }
}
