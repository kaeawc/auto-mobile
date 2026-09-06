import type { ToolSelectionProfileProvenanceLoader } from "../../src/server/toolSelectionProfileRegistry";

/**
 * No-op `ToolSelectionProfileProvenanceLoader` for daemon startup tests
 * (issue #6225) that must not resolve the real `getDatabase()` singleton via
 * the production `defaultToolSelectionProfileRegistry` default.
 */
export class FakeToolSelectionProfileProvenanceLoader implements ToolSelectionProfileProvenanceLoader {
  loadCalls = 0;

  async load(): Promise<void> {
    this.loadCalls += 1;
  }
}
