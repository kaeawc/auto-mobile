import { describe, expect, test } from "bun:test";
import { FakeNavigationGraphManager } from "./FakeNavigationGraphManager";

/**
 * The real NavigationGraphManager supports multiple graph-update listeners and
 * clears them all on null. The fake must mirror that fan-out so consumers wired
 * against it observe the same notification fidelity (issue #4171).
 */
describe("FakeNavigationGraphManager graph-update listeners", () => {
  test("returns a promise after recording the navigation state synchronously", async () => {
    const fake = new FakeNavigationGraphManager();

    const write = fake.recordNavigationEvent({
      destination: "Home",
      source: "test",
      arguments: {},
      metadata: {},
      timestamp: 123,
      sequenceNumber: 1,
    });

    expect(fake.getCurrentScreen()).toBe("Home");
    expect((await fake.exportGraph()).nodes).toEqual([
      { screenName: "Home", firstSeenAt: 123, lastSeenAt: 123, visitCount: 1 },
    ]);
    expect(write).toBeDefined();
    expect(typeof write.then).toBe("function");
    await write;
  });

  test("notifies every registered listener on a graph update", () => {
    const fake = new FakeNavigationGraphManager();
    const calls: string[] = [];
    fake.setGraphUpdateListener(() => calls.push("first"));
    fake.setGraphUpdateListener(() => calls.push("second"));

    fake.setCurrentApp("com.test.app");

    expect(calls.sort()).toEqual(["first", "second"]);
  });

  test("clears all listeners when set to null", () => {
    const fake = new FakeNavigationGraphManager();
    const calls: string[] = [];
    fake.setGraphUpdateListener(() => calls.push("first"));
    fake.setGraphUpdateListener(null);

    fake.setCurrentApp("com.test.app");

    expect(calls).toEqual([]);
  });
});
