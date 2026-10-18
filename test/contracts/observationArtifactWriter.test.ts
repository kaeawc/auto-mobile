import {
  JsonToolOutputArtifactWriter,
  type ToolOutputArtifactDirectoryEntry,
  type ToolOutputArtifactFileSystem,
} from "../../src/server/toolOutputArtifactWriter";
import { ToolOutputArtifactLedger } from "../../src/server/toolOutputArtifactLedger";
import { FakeArtifactWriter } from "../fakes/FakeArtifactWriter";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { runObservationArtifactWriterContract } from "./ObservationArtifactWriterContract";

/** In-memory seam so the real writer's naming and sizing run without touching disk. */
class InMemoryArtifactFileSystem implements ToolOutputArtifactFileSystem {
  private readonly files = new Map<string, string>();
  ensureDirectory(): void {}
  assertWritableDirectory(): void {}
  writeFileExclusive(filePath: string, content: string): void {
    if (this.files.has(filePath)) {
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    }
    this.files.set(filePath, content);
  }
  listFiles(): ToolOutputArtifactDirectoryEntry[] {
    return [];
  }
  deleteFile(filePath: string): void {
    this.files.delete(filePath);
  }
}

runObservationArtifactWriterContract("FakeArtifactWriter", () => new FakeArtifactWriter());
runObservationArtifactWriterContract(
  "JsonToolOutputArtifactWriter",
  () =>
    new JsonToolOutputArtifactWriter({
      outputDirectory: "/contract-tool-outputs",
      fileSystem: new InMemoryArtifactFileSystem(),
      idGenerator: new FakeIdGenerator(),
      timer: new FakeTimer(),
      ledger: new ToolOutputArtifactLedger(),
    }),
);
