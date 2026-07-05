import { describe, expect, test } from "bun:test";
import { NoopToolListChangedNotifier } from "../../../src/features/featureFlags/ToolListChangedNotifier";

describe("NoopToolListChangedNotifier", () => {
  test("does nothing and does not throw", () => {
    const notifier = new NoopToolListChangedNotifier();
    expect(() => notifier.notifyToolListChanged()).not.toThrow();
  });
});
