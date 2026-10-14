import type {
  MirroredSavedPrototype,
  SavedPrototypeMirror,
} from "../../src/features/prototype/savedPrototypeMirror";

export class FakeSavedPrototypeMirror implements SavedPrototypeMirror {
  readonly entries = new Map<string, Map<string, MirroredSavedPrototype>>();
  error: Error | undefined;
  async record(serial: string, entry: MirroredSavedPrototype): Promise<void> {
    if (this.error) {
      throw this.error;
    }
    const entries = this.entries.get(serial) ?? new Map();
    entries.set(entry.id, structuredClone(entry));
    this.entries.set(serial, entries);
  }
  async remove(serial: string, id: string): Promise<void> {
    if (this.error) {
      throw this.error;
    }
    this.entries.get(serial)?.delete(id);
  }
  async list(serial: string): Promise<MirroredSavedPrototype[]> {
    if (this.error) {
      throw this.error;
    }
    return structuredClone([...(this.entries.get(serial)?.values() ?? [])]);
  }
}
