import {
  expect,
  describe,
  test,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  spyOn,
} from "bun:test";
import { HierarchyNavigationDetector } from "../../../src/features/navigation/HierarchyNavigationDetector";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { AccessibilityHierarchy } from "../../../src/features/navigation/ScreenFingerprint";
import { FakeTimer } from "../../fakes/FakeTimer";
import { NavigationRepository } from "../../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../../src/db/testCoverageRepository";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

describe("NavigationGraphManager tool call attribution", () => {
  let harness: InMemoryNavManagerHarness;
  let manager: NavigationGraphManager;
  let timer: FakeTimer;

  beforeAll(async () => {
    harness = await installInMemoryNavManager();
  });
  beforeEach(async () => {
    await harness.manager.clearCurrentGraph();
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    manager = NavigationGraphManager.createForTesting(
      new NavigationRepository(harness.db),
      new TestCoverageRepository(undefined, harness.db),
      timer,
    );
    await manager.setCurrentApp("com.x");
    harness.manager = manager;
  });
  afterAll(async () => {
    await harness.dispose();
  });

  async function navigate(destination: string): Promise<void> {
    await manager.recordNavigationEvent({
      applicationId: "com.x",
      destination,
      source: "sdk",
      arguments: {},
      metadata: {},
      timestamp: timer.now(),
      sequenceNumber: 0,
    });
  }

  test("redirect chain Login -> Loading -> Home only attributes the first edge", async () => {
    await navigate("Login");
    timer.setCurrentTime(1_010_000);
    manager.recordToolCall("tapOn", { text: "Sign in" });
    timer.setCurrentTime(1_010_300);
    await navigate("Loading");
    timer.setCurrentTime(1_011_500);
    await navigate("Home");

    expect((await manager.getEdgesFrom("Login"))[0].interaction?.args).toEqual({ text: "Sign in" });
    expect((await manager.getEdgesFrom("Loading"))[0].interaction).toBeUndefined();
    expect((await manager.getStats()).toolCallHistorySize).toBe(0);
  });

  test("withdrawn failed tap cannot label Splash -> Home auto-advance", async () => {
    await navigate("Splash");
    timer.setCurrentTime(1_010_000);
    const withdraw = manager.recordToolCall("tapOn", { text: "Does not exist" });
    withdraw();
    timer.setCurrentTime(1_011_000);
    await navigate("Home");

    expect((await manager.getEdgesFrom("Splash"))[0].interaction).toBeUndefined();
  });

  test("initial and same-screen events leave a tap eligible for one transition", async () => {
    manager.recordToolCall("tapOn", { text: "Next" });
    await navigate("Login");
    await navigate("Login");
    await navigate("Home");
    expect((await manager.getEdgesFrom("Login"))[0].interaction?.args).toEqual({ text: "Next" });
  });

  test("a rolled-back edge write leaves the tool call eligible", async () => {
    await navigate("Login");
    manager.recordToolCall("tapOn", { text: "Next" });
    const createEdge = spyOn(NavigationRepository.prototype, "createEdge").mockRejectedValueOnce(
      new Error("edge write failed"),
    );
    try {
      await expect(navigate("Home")).rejects.toThrow("edge write failed");
    } finally {
      createEdge.mockRestore();
    }
    expect((await manager.getStats()).toolCallHistorySize).toBe(1);
    await navigate("Home");
    expect((await manager.getEdgesFrom("Login"))[0].interaction?.args).toEqual({ text: "Next" });
    expect((await manager.getStats()).toolCallHistorySize).toBe(0);
  });

  test("two successive tool calls each label their own edge", async () => {
    await navigate("Login");
    manager.recordToolCall("tapOn", { text: "Next" });
    await navigate("Loading");
    manager.recordToolCall("tapOn", { text: "Continue" });
    await navigate("Home");
    expect((await manager.getEdgesFrom("Login"))[0].interaction?.args).toEqual({ text: "Next" });
    expect((await manager.getEdgesFrom("Loading"))[0].interaction?.args).toEqual({
      text: "Continue",
    });
  });

  test("withdrawal is idempotent and cannot remove a newer call at the same timestamp", async () => {
    await navigate("Login");
    const withdraw = manager.recordToolCall("tapOn", { text: "Next" });
    await navigate("Loading");
    manager.recordToolCall("tapOn", { text: "Continue" });
    withdraw();
    withdraw();
    await navigate("Home");
    expect((await manager.getEdgesFrom("Loading"))[0].interaction?.args).toEqual({
      text: "Continue",
    });
  });

  test.each([2000, 2001])(
    "preserves the inclusive 2 s correlation window at %d ms",
    async (delay) => {
      await navigate("Login");
      manager.recordToolCall("tapOn", { text: "Next" });
      timer.advanceTime(delay);
      await navigate("Home");
      expect(Boolean((await manager.getEdgesFrom("Login"))[0].interaction)).toBe(delay === 2000);
    },
  );

  test("unmatched calls retain the existing 10 s TTL", async () => {
    manager.recordToolCall("tapOn", { text: "Old" });
    timer.advanceTime(10_000);
    await navigate("Login");
    expect((await manager.getStats()).toolCallHistorySize).toBe(1);
    timer.advanceTime(1);
    await navigate("Home");
    expect((await manager.getStats()).toolCallHistorySize).toBe(0);
    expect((await manager.getEdgesFrom("Login"))[0].interaction).toBeUndefined();
  });

  test("swipeOn retains scroll metadata but labels only its first transition", async () => {
    await navigate("Login");
    manager.recordToolCall("swipeOn", { direction: "down", lookFor: { text: "Next" } });
    const scrollPosition = { direction: "down" as const, targetElement: { text: "Next" } };
    manager.updateScrollPosition(scrollPosition);
    await navigate("Loading");
    await navigate("Home");
    expect((await manager.getEdgesFrom("Login"))[0].uiState?.scrollPosition).toEqual(
      scrollPosition,
    );
    expect((await manager.getEdgesFrom("Loading"))[0].interaction).toBeUndefined();
  });
});

describe("HierarchyNavigationDetector", () => {
  let manager: NavigationGraphManager;
  let detector: HierarchyNavigationDetector;
  let fakeTimer: FakeTimer;
  let navHarness: InMemoryNavManagerHarness;

  beforeAll(async () => {
    // Back the singleton with an in-memory, already-migrated DB (and silence the
    // fire-and-forget telemetry write) so the detector's navigation writes are
    // deterministic and never touch the real ~/.auto-mobile DB (issues #3063/#3067).
    navHarness = await installInMemoryNavManager();
    manager = navHarness.manager;
  });

  beforeEach(async () => {
    await manager.setCurrentApp("com.test.app");
    await manager.clearCurrentGraph();
    await manager.setCurrentApp("com.test.app");

    // Use FakeTimer in manual mode for deterministic timing
    fakeTimer = new FakeTimer();

    detector = new HierarchyNavigationDetector(manager, {
      debounceMs: 50,
      stabilityTimeoutMs: 200,
      timer: fakeTimer,
    });
  });

  afterEach(() => {
    detector.dispose();
    fakeTimer.reset();
  });

  afterAll(async () => {
    await navHarness.dispose();
  });

  describe("initial state", () => {
    test("should start with no fingerprints", () => {
      expect(detector.getCurrentFingerprint()).toBeNull();
      expect(detector.getPreviousFingerprint()).toBeNull();
      expect(detector.hasPendingFingerprint()).toBe(false);
    });
  });

  describe("onHierarchyUpdate", () => {
    test("should set pending fingerprint on first update", () => {
      const hierarchy = createHierarchy("Screen A");
      detector.onHierarchyUpdate(hierarchy);

      expect(detector.hasPendingFingerprint()).toBe(true);
      expect(detector.getCurrentFingerprint()).toBeNull(); // Not stable yet
    });

    test("should stabilize fingerprint after debounce", () => {
      const hierarchy = createHierarchy("Screen A");
      detector.onHierarchyUpdate(hierarchy);

      // Advance time past debounce
      fakeTimer.advanceTime(60);

      expect(detector.hasPendingFingerprint()).toBe(false);
      expect(detector.getCurrentFingerprint()).not.toBeNull();
      expect(detector.getCurrentFingerprint()?.packageName).toBe("com.test.app");
    });

    test("should reset debounce timer on new fingerprint", () => {
      const hierarchy1 = createHierarchy("Screen A");
      const hierarchy2 = createHierarchy("Screen B");

      detector.onHierarchyUpdate(hierarchy1);
      fakeTimer.advanceTime(30); // Less than debounce

      detector.onHierarchyUpdate(hierarchy2);
      fakeTimer.advanceTime(30); // Less than debounce from second update

      // Should still be pending (timer was reset)
      expect(detector.hasPendingFingerprint()).toBe(true);

      // Advance past debounce
      fakeTimer.advanceTime(30);

      // Should now be stable with Screen B
      expect(detector.hasPendingFingerprint()).toBe(false);
      expect(detector.getCurrentFingerprint()).not.toBeNull();
    });

    test("should not reset timer for same fingerprint", () => {
      const hierarchy = createHierarchy("Screen A");

      detector.onHierarchyUpdate(hierarchy);
      fakeTimer.advanceTime(30);

      // Same hierarchy again - should not reset timer
      detector.onHierarchyUpdate(hierarchy);
      fakeTimer.advanceTime(30);

      // Should be stable now (60ms > 50ms debounce)
      expect(detector.hasPendingFingerprint()).toBe(false);
      expect(detector.getCurrentFingerprint()).not.toBeNull();
    });
  });

  describe("navigation detection", () => {
    test("should detect navigation when fingerprint changes", () => {
      const hierarchy1 = createHierarchy("Screen A");
      const hierarchy2 = createHierarchy("Screen B");

      // First screen
      detector.onHierarchyUpdate(hierarchy1);
      fakeTimer.advanceTime(60);

      const firstFingerprint = detector.getCurrentFingerprint();
      expect(firstFingerprint).not.toBeNull();

      // Navigate to second screen
      detector.onHierarchyUpdate(hierarchy2);
      fakeTimer.advanceTime(60);

      const secondFingerprint = detector.getCurrentFingerprint();
      expect(secondFingerprint).not.toBeNull();
      expect(secondFingerprint?.hash).not.toBe(firstFingerprint?.hash);

      // Previous should be first screen
      expect(detector.getPreviousFingerprint()?.hash).toBe(firstFingerprint?.hash);
    });

    test("should call recordHierarchyNavigation on graph manager", async () => {
      // Note: With the named-nodes-only feature, hierarchy events only create nodes
      // if there's an active navigation from an SDK event within the correlation window.
      // Without SDK events, hierarchy navigation is tracked as suggestions (if app has named nodes)
      // or ignored entirely (if app has no named nodes).

      const hierarchy1 = createHierarchy("Screen A");
      const hierarchy2 = createHierarchy("Screen B");

      detector.onHierarchyUpdate(hierarchy1);
      fakeTimer.advanceTime(60);

      detector.onHierarchyUpdate(hierarchy2);
      fakeTimer.advanceTime(60);

      // Wait for async navigation recording
      await new Promise((resolve) => setImmediate(resolve));

      // For apps without SDK events (no named nodes), hierarchy events don't create screens
      // They are silently ignored until the app has named nodes from SDK integration
      const screens = await manager.getKnownScreens();
      expect(screens.length).toBe(0); // No named nodes yet

      // The detector should still track fingerprints internally
      expect(detector.getCurrentFingerprint()).not.toBeNull();
      expect(detector.getPreviousFingerprint()).not.toBeNull();
    });

    test("should not detect navigation for same fingerprint", () => {
      const hierarchy = createHierarchy("Screen A");

      detector.onHierarchyUpdate(hierarchy);
      fakeTimer.advanceTime(60);

      const firstFingerprint = detector.getCurrentFingerprint();

      // Same hierarchy again
      detector.onHierarchyUpdate(hierarchy);
      fakeTimer.advanceTime(60);

      // Should still be same fingerprint, no navigation
      expect(detector.getCurrentFingerprint()?.hash).toBe(firstFingerprint?.hash);
      expect(detector.getPreviousFingerprint()).toBeNull(); // No navigation occurred
    });
  });

  describe("stability timeout", () => {
    test("should force navigation detection after timeout", () => {
      // Create detector with long debounce, short timeout
      detector.dispose();
      const longDebounceTimer = new FakeTimer();
      detector = new HierarchyNavigationDetector(manager, {
        debounceMs: 1000, // Long debounce
        stabilityTimeoutMs: 100, // Short timeout
        timer: longDebounceTimer,
      });

      const hierarchy1 = createHierarchy("Screen A");
      detector.onHierarchyUpdate(hierarchy1);

      // Advance past stability timeout (not debounce)
      longDebounceTimer.advanceTime(150);

      // Should have forced stable despite long debounce
      expect(detector.hasPendingFingerprint()).toBe(false);
      expect(detector.getCurrentFingerprint()).not.toBeNull();
    });
  });

  describe("reset", () => {
    test("should clear all state", () => {
      const hierarchy = createHierarchy("Screen A");
      detector.onHierarchyUpdate(hierarchy);
      fakeTimer.advanceTime(60);

      expect(detector.getCurrentFingerprint()).not.toBeNull();

      detector.reset();

      expect(detector.getCurrentFingerprint()).toBeNull();
      expect(detector.getPreviousFingerprint()).toBeNull();
      expect(detector.hasPendingFingerprint()).toBe(false);
    });

    test("should clear pending timers", () => {
      const hierarchy = createHierarchy("Screen A");
      detector.onHierarchyUpdate(hierarchy);

      expect(detector.hasPendingFingerprint()).toBe(true);

      detector.reset();

      expect(detector.hasPendingFingerprint()).toBe(false);
    });
  });

  describe("dispose", () => {
    test("stops a pending fingerprint from ever stabilizing after dispose", () => {
      const hierarchy = createHierarchy("Screen A");
      detector.onHierarchyUpdate(hierarchy);
      expect(detector.hasPendingFingerprint()).toBe(true);

      detector.dispose();

      // dispose() cancels the debounce and stability timers, so advancing well
      // past both deadlines must NOT stabilize the pending fingerprint or record
      // a navigation. A no-op dispose() would let the debounce fire and promote
      // the fingerprint, so getCurrentFingerprint would become non-null.
      fakeTimer.advanceTime(10_000);

      expect(detector.getCurrentFingerprint()).toBeNull();
      expect(detector.getPreviousFingerprint()).toBeNull();
      // dispose() only tears down timers; it does not reset accumulated state,
      // so the pending fingerprint is still parked (distinct from reset()).
      expect(detector.hasPendingFingerprint()).toBe(true);
    });
  });

  describe("navigation callback", () => {
    interface CallbackInfo {
      packageName: string | null;
      screenFingerprint: string;
      timestamp: number;
    }

    test("invokes the navigation callback once per detected navigation", () => {
      const seen: CallbackInfo[] = [];
      detector.setNavigationCallback((info) => seen.push(info));

      // The very first stabilization (initial -> Screen A) is itself a recorded
      // navigation, so the callback fires here too — not only on the A -> B hop.
      detector.onHierarchyUpdate(createHierarchy("Screen A"));
      fakeTimer.advanceTime(60);

      detector.onHierarchyUpdate(createHierarchy("Screen B"));
      fakeTimer.advanceTime(60);

      expect(seen).toHaveLength(2);
      expect(seen.at(-1)!.packageName).toBe("com.test.app");
      expect(seen.at(-1)!.screenFingerprint).toBe(detector.getCurrentFingerprint()!.hash);
    });

    test("keeps detecting navigation when the callback throws", () => {
      detector.setNavigationCallback(() => {
        throw new Error("screenshot capture blew up");
      });

      // A throwing callback must be swallowed: advancing the debounce timer (which
      // fires the callback synchronously) must not propagate, and fingerprint
      // state must still advance. Dropping the try/catch would let this throw out
      // of advanceTime and fail the test.
      detector.onHierarchyUpdate(createHierarchy("Screen A"));
      fakeTimer.advanceTime(60);
      detector.onHierarchyUpdate(createHierarchy("Screen B"));
      fakeTimer.advanceTime(60);

      const current = detector.getCurrentFingerprint();
      const previous = detector.getPreviousFingerprint();
      expect(current).not.toBeNull();
      expect(previous).not.toBeNull();
      expect(current!.hash).not.toBe(previous!.hash);
    });

    test("stops invoking the callback after it is cleared", () => {
      const seen: CallbackInfo[] = [];
      detector.setNavigationCallback((info) => seen.push(info));
      detector.setNavigationCallback(null);

      detector.onHierarchyUpdate(createHierarchy("Screen A"));
      fakeTimer.advanceTime(60);
      detector.onHierarchyUpdate(createHierarchy("Screen B"));
      fakeTimer.advanceTime(60);

      expect(seen).toHaveLength(0);
    });
  });

  describe("tool call correlation", () => {
    test("should record tool calls even without SDK integration", async () => {
      // Note: With the named-nodes-only feature, hierarchy events don't create edges
      // without SDK integration. Tool calls are still recorded for future correlation
      // when SDK events arrive.

      // First screen - stabilize
      const hierarchy1: AccessibilityHierarchy = {
        updatedAt: Date.now(),
        packageName: "com.test.app",
        hierarchy: {
          text: "Screen A",
          "resource-id": "com.test.app:id/screen_a",
        },
      };
      detector.onHierarchyUpdate(hierarchy1);
      fakeTimer.advanceTime(60);

      // Wait for async recording
      await new Promise((resolve) => setImmediate(resolve));

      // Record a tool call BEFORE the second screen appears
      manager.recordToolCall("tapOn", { text: "Next" });

      // Second screen appears (navigation triggered by tool call)
      const hierarchy2: AccessibilityHierarchy = {
        updatedAt: Date.now(),
        packageName: "com.test.app",
        hierarchy: {
          text: "Screen B",
          "resource-id": "com.test.app:id/screen_b",
        },
      };
      detector.onHierarchyUpdate(hierarchy2);
      fakeTimer.advanceTime(60);

      // Wait for async navigation recording
      await new Promise((resolve) => setImmediate(resolve));

      // Without SDK events (named nodes), no screens or edges are created
      // The detector tracks fingerprints internally, but they aren't recorded
      // as named nodes in the graph
      const screens = await manager.getKnownScreens();
      expect(screens.length).toBe(0);

      // Tool call should still be recorded in history
      const stats = await manager.getStats();
      expect(stats.toolCallHistorySize).toBe(1);

      // The detector should still track fingerprints
      expect(detector.getCurrentFingerprint()).not.toBeNull();
      expect(detector.getPreviousFingerprint()).not.toBeNull();
    });
  });
});

// Helper to create hierarchy with unique content
function createHierarchy(uniqueContent: string): AccessibilityHierarchy {
  return {
    updatedAt: Date.now(),
    packageName: "com.test.app",
    hierarchy: {
      text: uniqueContent,
      "resource-id": `com.test.app:id/${uniqueContent.toLowerCase().replace(/\s/g, "_")}`,
    },
  };
}
