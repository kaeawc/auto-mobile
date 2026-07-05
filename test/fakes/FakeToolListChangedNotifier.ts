import type { ToolListChangedNotifier } from "../../src/features/featureFlags/ToolListChangedNotifier";

/**
 * Test double that counts how many times `tools/list_changed` would be emitted,
 * so tests can assert exactly when a runtime flag toggle notifies MCP clients
 * (issue #2963).
 */
export class FakeToolListChangedNotifier implements ToolListChangedNotifier {
  count = 0;

  notifyToolListChanged(): void {
    this.count += 1;
  }
}
