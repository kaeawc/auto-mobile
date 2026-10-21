import type { PrototypeAssetCache } from "../../src/features/prototype/prototypeAssetCache";
import type { PrototypeAssetUpload } from "../../src/features/prototype/prototypeAssets";

export class FakePrototypeAssetCache implements PrototypeAssetCache {
  readonly entries = new Map<string, Map<string, PrototypeAssetUpload>>();
  putError: Error | undefined;
  getErrors = new Map<string, Error>();
  idsError: Error | undefined;
  async put(serial: string, upload: PrototypeAssetUpload): Promise<void> {
    if (this.putError) {
      throw this.putError;
    }
    const entries = this.entries.get(serial) ?? new Map();
    entries.set(upload.id, structuredClone(upload));
    this.entries.set(serial, entries);
  }
  async get(serial: string, id: string): Promise<PrototypeAssetUpload | undefined> {
    const error = this.getErrors.get(id);
    if (error) {
      throw error;
    }
    const upload = this.entries.get(serial)?.get(id);
    return upload ? structuredClone(upload) : undefined;
  }
  async ids(serial: string): Promise<ReadonlySet<string>> {
    if (this.idsError) {
      throw this.idsError;
    }
    return new Set(this.entries.get(serial)?.keys());
  }
  async remove(serial: string, id: string): Promise<void> {
    this.entries.get(serial)?.delete(id);
  }
}
