import type {
  SavedPrototypeLayoutWriter,
  SavedPrototypeLayoutRequest,
  SavedPrototypeLayoutWriteResult,
} from "../../src/features/prototype/savedPrototypeLayout";
export class FakeSavedPrototypeLayoutWriter implements SavedPrototypeLayoutWriter {
  requests: { request: SavedPrototypeLayoutRequest; destination: string }[] = [];
  result?: SavedPrototypeLayoutWriteResult;
  async write(
    request: SavedPrototypeLayoutRequest,
    destination: string,
  ): Promise<SavedPrototypeLayoutWriteResult> {
    this.requests.push({ request, destination });
    return (
      this.result ?? {
        kind: "written",
        destination,
        replaced: false,
        manifest: { formatVersion: 1, specFile: "spec.json", assets: [], fonts: [] },
      }
    );
  }
}
