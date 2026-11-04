import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getTempDir } from "../../../utils/tempDir";
import type { ProtoViewerShareFiles } from "./protoViewerShare";

/**
 * Share files live under the AutoMobile data directory, not the OS temp directory: the user still
 * has to upload the bundle after the call returns, so it must outlive temp cleanup.
 */
export class NodeProtoViewerShareFiles implements ProtoViewerShareFiles {
  outputDir(): string {
    return getTempDir("prototype-shares");
  }

  async write(filePath: string, bytes: Uint8Array): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, bytes, { mode: 0o644 });
  }
}
