import type { ToolListChangedNotifier } from "../../src/features/featureFlags/ToolListChangedNotifier";

/**
 * Test double that counts how many times `tools/list_changed` would be emitted,
 * so tests can assert exactly when a runtime flag toggle notifies MCP clients
 * (issue #2963). Set `shouldThrow` to verify the caller swallows notifier errors.
 */
export class FakeToolListChangedNotifier implements ToolListChangedNotifier {
  count = 0;
  shouldThrow = false;

  notifyToolListChanged(): void {
    this.count += 1;
    if (this.shouldThrow) {
      throw new Error("notifier boom");
    }
  }
}
