import type { SourceReader } from "../../scripts/lib/affectedTests";

export class FakeSourceReader implements SourceReader {
  constructor(readonly files: Record<string, string>) {}
  list(): string[] {
    return Object.keys(this.files);
  }
  read(file: string): string {
    if (!Object.hasOwn(this.files, file)) {
      throw new Error(`Missing fake file: ${file}`);
    }
    return this.files[file];
  }
}
