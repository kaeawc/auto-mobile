import type { ProtoViewerShareFiles } from "../../src/features/prototype/protoViewer/protoViewerShare";

/** In-memory share output; records every write so tests can prove what reached "disk". */
export class FakeProtoViewerShareFiles implements ProtoViewerShareFiles {
  readonly written = new Map<string, Uint8Array>();

  constructor(private readonly directory = "/data/prototype-shares") {}

  outputDir(): string {
    return this.directory;
  }

  async write(filePath: string, bytes: Uint8Array): Promise<void> {
    this.written.set(filePath, bytes);
  }
}
