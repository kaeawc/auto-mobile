import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProtoViewerTempFile, ProtoViewerTempFiles } from "./AndroidProtoViewer";

/**
 * A private (0700) temp directory per bundle, removed with the file once it has been pushed. The
 * file itself is 0644: adb push carries the local mode to the device, and the app, a different
 * uid, must be able to read what the shell pushed (#15174).
 */
export class NodeProtoViewerTempFiles implements ProtoViewerTempFiles {
  async write(bytes: Uint8Array): Promise<ProtoViewerTempFile> {
    const directory = await mkdtemp(join(tmpdir(), "automobile-protoviewer-"));
    const path = join(directory, "bundle.automobile-proto");
    await writeFile(path, bytes, { mode: 0o644 });
    return { path, dispose: () => rm(directory, { recursive: true, force: true }) };
  }
}
