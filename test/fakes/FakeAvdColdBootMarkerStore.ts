import type { AvdColdBootMarkerStore } from "../../src/utils/android-cmdline-tools/AvdColdBootMarkerStore";

export class FakeAvdColdBootMarkerStore implements AvdColdBootMarkerStore {
  readonly marked = new Set<string>();
  readonly calls: string[] = [];
  failure?: "read" | "write" | "remove";

  async isMarked(avdName: string): Promise<boolean> {
    this.calls.push(`read:${avdName}`);
    if (this.failure === "read") {
      throw new Error("marker read failed");
    }
    return this.marked.has(avdName);
  }
  async mark(avdName: string): Promise<void> {
    this.calls.push(`write:${avdName}`);
    if (this.failure === "write") {
      throw new Error("marker write failed");
    }
    this.marked.add(avdName);
  }
  async clear(avdName: string): Promise<void> {
    this.calls.push(`remove:${avdName}`);
    if (this.failure === "remove") {
      throw new Error("marker remove failed");
    }
    this.marked.delete(avdName);
  }
}
