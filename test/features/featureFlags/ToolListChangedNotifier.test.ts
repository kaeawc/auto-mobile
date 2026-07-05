import { describe, expect, test } from "bun:test";
import {
  McpServerToolListChangedNotifier,
  NoopToolListChangedNotifier,
  type ToolListChangeBroadcaster,
} from "../../../src/features/featureFlags/ToolListChangedNotifier";

class FakeBroadcaster implements ToolListChangeBroadcaster {
  calls = 0;
  shouldThrow = false;

  sendToolListChanged(): void {
    this.calls += 1;
    if (this.shouldThrow) {
      throw new Error("send boom");
    }
  }
}

describe("McpServerToolListChangedNotifier", () => {
  test("delegates to server.sendToolListChanged()", () => {
    const server = new FakeBroadcaster();
    const notifier = new McpServerToolListChangedNotifier(server);

    notifier.notifyToolListChanged();

    expect(server.calls).toBe(1);
  });

  test("swallows broadcaster errors (best-effort)", () => {
    const server = new FakeBroadcaster();
    server.shouldThrow = true;
    const notifier = new McpServerToolListChangedNotifier(server);

    expect(() => notifier.notifyToolListChanged()).not.toThrow();
    expect(server.calls).toBe(1);
  });
});

describe("NoopToolListChangedNotifier", () => {
  test("does nothing and does not throw", () => {
    const notifier = new NoopToolListChangedNotifier();
    expect(() => notifier.notifyToolListChanged()).not.toThrow();
  });
});
