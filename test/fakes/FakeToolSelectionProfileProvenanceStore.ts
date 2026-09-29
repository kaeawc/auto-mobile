import type { ToolSelectionProfileProvenanceStore } from "../../src/db/toolSelectionProfileProvenanceRepository";

/** In-memory provenance store shared by registry and proxy tests. */
export class FakeToolSelectionProfileProvenanceStore implements ToolSelectionProfileProvenanceStore {
  readonly stored = new Set<string>();
  readonly insertCalls: string[] = [];

  async insert(profileUuid: string): Promise<void> {
    this.insertCalls.push(profileUuid);
    this.stored.add(profileUuid);
  }

  async loadAll(): Promise<string[]> {
    return [...this.stored];
  }
}
