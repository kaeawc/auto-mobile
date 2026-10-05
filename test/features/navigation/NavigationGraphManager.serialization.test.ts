import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { NavigationRepository } from "../../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../../src/db/testCoverageRepository";
import { ActionableError } from "../../../src/models/ActionableError";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

const APP_ID = "com.test.serial";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("NavigationGraphManager navigation write ordering", () => {
  let harness: InMemoryNavManagerHarness;
  let repository: NavigationRepository;
  let manager: NavigationGraphManager;
  let appId: string;
  let appNumber = 0;

  beforeAll(async () => {
    harness = await installInMemoryNavManager();
  });

  beforeEach(async () => {
    appId = `${APP_ID}.${++appNumber}`;
    repository = new NavigationRepository(harness.db);
    manager = NavigationGraphManager.createForTesting(
      repository,
      new TestCoverageRepository(undefined, harness.db),
      new FakeTimer(),
    );
    await manager.setCurrentApp(appId);
    await manager.recordNavigationEvent({ destination: "Home", timestamp: 1000 });
    await manager.recordHierarchyNavigation({
      packageName: appId,
      fromFingerprint: null,
      toFingerprint: "fp_home",
      timestamp: 1200,
    });
    await manager.recordNavigationEvent({ destination: "Other", timestamp: 3000 });
  });

  afterAll(async () => {
    await harness.dispose();
  });

  test("does not correlate another app inside the SDK window or on a later revisit", async () => {
    const otherApp = `${appId}.other`;
    await manager.recordNavigationEvent({
      applicationId: appId,
      destination: "Checkout",
      timestamp: 1000,
    });
    const checkout = await repository.getNode(appId, "Checkout");
    const fingerprints = await repository.getFingerprintsForNode(checkout!.id);
    for (const timestamp of [1200, 9000]) {
      await manager.recordHierarchyNavigation({
        packageName: otherApp,
        fromFingerprint: null,
        toFingerprint: "fp_other",
        timestamp,
      });
      expect(manager.getCurrentAppId()).toBe(otherApp);
      expect(manager.getCurrentScreen()).toBeNull();
      expect(await repository.getNodeByFingerprint(otherApp, "fp_other")).toBeUndefined();
      expect(await repository.getNode(appId, "Checkout")).toEqual(checkout);
      expect(await repository.getFingerprintsForNode(checkout!.id)).toEqual(fingerprints);
    }
    // The other app still records and correlates its own SDK navigation normally.
    await manager.recordNavigationEvent({
      applicationId: otherApp,
      destination: "Browser",
      timestamp: 10000,
    });
    await manager.recordHierarchyNavigation({
      packageName: otherApp,
      fromFingerprint: null,
      toFingerprint: "fp_other",
      timestamp: 10200,
    });
    await manager.recordHierarchyNavigation({
      packageName: otherApp,
      fromFingerprint: null,
      toFingerprint: "fp_other",
      timestamp: 12000,
    });
    expect(manager.getCurrentScreen()).toBe("Browser");
    expect(await repository.getNodeByFingerprint(otherApp, "fp_other")).toMatchObject({
      app_id: otherApp,
      screen_name: "Browser",
      visit_count: 2,
    });
    expect(await repository.getNode(appId, "Checkout")).toEqual(checkout);
  });

  test("drops pending correlation even when the original app returns inside the window", async () => {
    await manager.setCurrentApp(`${appId}.other`);
    await manager.setCurrentApp(appId);
    await manager.recordHierarchyNavigation({
      packageName: appId,
      fromFingerprint: null,
      toFingerprint: "fp_return",
      timestamp: 3200,
    });
    expect(await repository.getNodeByFingerprint(appId, "fp_return")).toBeUndefined();
    expect(manager.getCurrentScreen()).toBeNull();
  });

  test("clearAllGraphs drops pending correlation with the deleted node", async () => {
    await manager.clearAllGraphs();
    await manager.recordHierarchyNavigation({
      packageName: appId,
      fromFingerprint: null,
      toFingerprint: "fp_cleared",
      timestamp: 3200,
    });
    expect(
      await harness.db
        .selectFrom("navigation_node_fingerprints")
        .selectAll()
        .where("app_id", "=", appId)
        .where("fingerprint_hash", "=", "fp_cleared")
        .execute(),
    ).toEqual([]);
    expect(await repository.getNodeByFingerprint(appId, "fp_cleared")).toBeUndefined();
    expect(manager.getCurrentScreen()).toBeNull();
  });

  for (const change of [
    { versionCode: 1, contentHash: "" },
    { versionCode: 0, contentHash: "new-build" },
  ]) {
    test(`correlates the same app across a change in ${change.versionCode ? "versionCode" : "contentHash"}`, async () => {
      manager.setBuildContext({ appId, deviceId: "test-device", ...change });
      await manager.recordHierarchyNavigation({
        packageName: appId,
        fromFingerprint: null,
        toFingerprint: "fp_new_build",
        timestamp: 3200,
      });
      expect(await repository.getNodeByFingerprint(appId, "fp_new_build")).toEqual(
        await repository.getNode(appId, "Other"),
      );
      expect(manager.getCurrentScreen()).toBe("Other");
    });
  }

  test("correlates a cold-start SDK navigation after its build context resolves", async () => {
    const coldApp = `${appId}.cold`;
    expect(manager.getBuildContexts()).toEqual([]);
    await manager.recordNavigationEvent({
      applicationId: coldApp,
      destination: "Welcome",
      timestamp: 4000,
    });
    const node = await repository.getNode(coldApp, "Welcome");
    expect(node).toBeDefined();
    manager.setBuildContext({
      appId: coldApp,
      deviceId: "test-device",
      versionCode: 42,
      contentHash: "resolved-bundle-hash",
    });
    await manager.recordHierarchyNavigation({
      packageName: coldApp,
      fromFingerprint: null,
      toFingerprint: "fp_cold_start",
      timestamp: 4200,
    });
    expect(await repository.getNodeByFingerprint(coldApp, "fp_cold_start")).toEqual(node);
    expect(manager.getCurrentScreen()).toBe("Welcome");
  });

  test("correlates the same app after its build context is cleared", async () => {
    manager.setBuildContext({
      appId,
      deviceId: "test-device",
      versionCode: 42,
      contentHash: "resolved-bundle-hash",
    });
    await manager.recordNavigationEvent({ destination: "Checkout", timestamp: 4000 });
    const node = await repository.getNode(appId, "Checkout");
    expect(node).toBeDefined();
    manager.clearBuildContext(appId);
    expect(manager.getBuildContexts()).toEqual([]);
    await manager.recordHierarchyNavigation({
      packageName: appId,
      fromFingerprint: null,
      toFingerprint: "fp_cleared_build",
      timestamp: 4200,
    });
    expect(await repository.getNodeByFingerprint(appId, "fp_cleared_build")).toEqual(node);
    expect(manager.getCurrentScreen()).toBe("Checkout");
  });

  test("same app and build still correlate at the inclusive one-second boundary", async () => {
    const context = { appId, versionCode: 3, contentHash: "build", deviceId: "device-one" };
    manager.setBuildContext(context);
    await manager.recordNavigationEvent({ destination: "Checkout", timestamp: 4000 });
    // Device identity is provenance, not part of the graph's app/build key.
    manager.setBuildContext({ ...context, deviceId: "device-two" });
    await manager.recordHierarchyNavigation({
      packageName: appId,
      fromFingerprint: null,
      toFingerprint: "fp_checkout",
      timestamp: 5000,
    });
    expect(await repository.getNodeByFingerprint(appId, "fp_checkout")).toMatchObject({
      app_id: appId,
      screen_name: "Checkout",
    });
    expect(manager.getCurrentScreen()).toBe("Checkout");
  });

  test("ignores an already-persisted fingerprint pointing at another app's node", async () => {
    const otherApp = `${appId}.other`;
    const node = await repository.getNode(appId, "Other");
    await repository.getOrCreateApp(otherApp);
    await repository.getOrCreateFingerprint(otherApp, node!.id, "fp_corrupt", "{}", 3200);
    await manager.recordHierarchyNavigation({
      packageName: otherApp,
      fromFingerprint: null,
      toFingerprint: "fp_corrupt",
      timestamp: 9000,
    });
    expect(await repository.getNodeByFingerprint(otherApp, "fp_corrupt")).toBeUndefined();
    expect(manager.getCurrentScreen()).toBeNull();
    expect(await repository.getNode(appId, "Other")).toEqual(node);
  });

  test("sanitizes legacy edge arguments on graph reads and pathfinding without rewriting storage", async () => {
    const args = {
      text: "Continue",
      sessionUuid: "old",
      __mcpRequestDeadlineMs: 1,
      __mcpRequestTimeoutMs: 2,
      __futureInternal: true,
      _foo: "keep",
      sessionUuidX: "keep",
      session: "keep",
    };
    await repository.createEdge(appId, "Other", "Home", "tapOn", args, 4000);
    const expected = { text: "Continue", _foo: "keep", sessionUuidX: "keep", session: "keep" };
    expect((await manager.getEdgesFrom("Other"))[0].interaction?.args).toEqual(expected);
    expect((await manager.findPath("Home")).path[0].interaction?.args).toEqual(expected);
    expect(JSON.parse((await repository.getEdgesFrom(appId, "Other"))[0].tool_args!)).toEqual(args);
  });

  for (const variant of ["empty", "selected", "scroll", "combined"] as const) {
    test(`edge conversion preserves ${variant} UI state, empty identifiers and modal stacks`, async () => {
      const edge = await repository.createEdge(appId, "Other", "Home", "tapOn", null, 4000);
      const selected = await repository.getOrCreateUIElement(
        appId,
        { text: "", resourceId: "id/tab", contentDescription: "" },
        4000,
      );
      const target = await repository.getOrCreateUIElement(
        appId,
        { text: "Target", resourceId: "", contentDescription: "Target description" },
        4000,
      );
      const container = await repository.getOrCreateUIElement(
        appId,
        { text: "", resourceId: "id/list", contentDescription: "" },
        4000,
      );
      if (variant === "selected" || variant === "combined") {
        await repository.linkUIElementsToEdge(edge.id, [selected.id]);
      }
      if (variant === "scroll" || variant === "combined") {
        await repository.setScrollPosition(
          edge.id,
          target.id,
          "down",
          variant === "combined" ? container.id : undefined,
          variant === "combined" ? "fast" : undefined,
        );
      }
      await repository.setEdgeModals(edge.id, "from", ["dialog", "menu"]);
      await repository.setEdgeModals(edge.id, "to", ["sheet"]);

      const [converted] = await manager.getEdgesFrom("Other");
      expect(converted).toMatchObject({
        from: "Other",
        to: "Home",
        timestamp: 4000,
        edgeType: "tool",
        interaction: { toolName: "tapOn", args: {}, timestamp: 4000 },
      });
      expect(converted.fromModalStack).toEqual([
        { type: "overlay", identifier: "dialog", layer: 0 },
        { type: "overlay", identifier: "menu", layer: 1 },
      ]);
      expect(converted.toModalStack).toEqual([{ type: "overlay", identifier: "sheet", layer: 0 }]);
      expect(converted.uiState).toBe(converted.interaction?.uiState);
      if (variant === "empty") {
        expect(converted.uiState).toBeUndefined();
        return;
      }
      expect(converted.uiState?.selectedElements).toEqual(
        variant === "scroll"
          ? []
          : [{ text: undefined, resourceId: "id/tab", contentDesc: undefined }],
      );
      expect(converted.uiState?.scrollPosition).toEqual(
        variant === "selected"
          ? undefined
          : {
              targetElement: {
                text: "Target",
                resourceId: undefined,
                contentDesc: "Target description",
              },
              direction: "down",
              speed: variant === "combined" ? "fast" : undefined,
              ...(variant === "combined"
                ? { container: { text: undefined, resourceId: "id/list", contentDesc: undefined } }
                : {}),
            },
      );
    });
  }

  test("unknown edges skip interaction reads but retain modal stacks", async () => {
    const edge = await repository.createEdge(appId, "Other", "Home", null, null, 4000);
    await repository.setEdgeModals(edge.id, "to", ["sheet"]);
    const ui = spyOn(repository, "getUIElementsForEdge");
    const scroll = spyOn(repository, "getScrollPosition");
    try {
      const [converted] = await manager.getEdgesFrom("Other");
      expect(converted.edgeType).toBe("unknown");
      expect(converted.interaction).toBeUndefined();
      expect(converted.uiState).toBeUndefined();
      expect(converted.fromModalStack).toBeUndefined();
      expect(converted.toModalStack).toEqual([{ type: "overlay", identifier: "sheet", layer: 0 }]);
      expect(ui).not.toHaveBeenCalled();
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      ui.mockRestore();
      scroll.mockRestore();
    }
  });

  test("edge reads await UI, scroll, from modals and to modals before starting the next edge", async () => {
    const first = await repository.createEdge(appId, "Other", "Home", "tapOn", {}, 4000);
    const second = await repository.createEdge(appId, "Other", "Home", "swipeOn", {}, 5000);
    const gates = Array.from({ length: 4 }, () => deferred());
    const started = Array.from({ length: 4 }, () => deferred());
    const calls: string[] = [];
    const ui = spyOn(repository, "getUIElementsForEdge").mockImplementation(async (id) => {
      calls.push(`ui:${id}`);
      if (id === first.id) {
        started[0].resolve();
        await gates[0].promise;
      }
      return [];
    });
    const scroll = spyOn(repository, "getScrollPosition").mockImplementation(async (id) => {
      calls.push(`scroll:${id}`);
      if (id === first.id) {
        started[1].resolve();
        await gates[1].promise;
      }
      return null;
    });
    const modals = spyOn(repository, "getEdgeModals").mockImplementation(async (id, position) => {
      calls.push(`${position}:${id}`);
      if (id === first.id) {
        const index = position === "from" ? 2 : 3;
        started[index].resolve();
        await gates[index].promise;
      }
      return [];
    });
    try {
      const reading = manager.getEdgesFrom("Other");
      for (let index = 0; index < gates.length; index++) {
        await started[index].promise;
        expect(calls).toEqual(
          [`ui:${first.id}`, `scroll:${first.id}`, `from:${first.id}`, `to:${first.id}`].slice(
            0,
            index + 1,
          ),
        );
        gates[index].resolve();
      }
      expect(await reading).toHaveLength(2);
      expect(calls).toEqual([
        `ui:${first.id}`,
        `scroll:${first.id}`,
        `from:${first.id}`,
        `to:${first.id}`,
        `ui:${second.id}`,
        `scroll:${second.id}`,
        `from:${second.id}`,
        `to:${second.id}`,
      ]);
    } finally {
      for (const gate of gates) {
        gate.resolve();
      }
      ui.mockRestore();
      scroll.mockRestore();
      modals.mockRestore();
    }
  });

  test("invalid stored JSON throws before any interaction or modal reads", async () => {
    const edge = await repository.createEdge(appId, "Other", "Home", "tapOn", {}, 4000);
    await harness.db
      .updateTable("navigation_edges")
      .set({ tool_args: "{" })
      .where("id", "=", edge.id)
      .execute();
    const ui = spyOn(repository, "getUIElementsForEdge");
    const scroll = spyOn(repository, "getScrollPosition");
    const modals = spyOn(repository, "getEdgeModals");
    try {
      await expect(manager.getEdgesFrom("Other")).rejects.toBeInstanceOf(SyntaxError);
      expect(ui).not.toHaveBeenCalled();
      expect(scroll).not.toHaveBeenCalled();
      expect(modals).not.toHaveBeenCalled();
    } finally {
      ui.mockRestore();
      scroll.mockRestore();
      modals.mockRestore();
    }
  });

  test("a UI read rejection propagates unchanged before scroll or modal reads", async () => {
    await repository.createEdge(appId, "Other", "Home", "tapOn", {}, 4000);
    const failure = new Error("UI read failed");
    const ui = spyOn(repository, "getUIElementsForEdge").mockRejectedValue(failure);
    const scroll = spyOn(repository, "getScrollPosition");
    const modals = spyOn(repository, "getEdgeModals");
    try {
      await expect(manager.getEdgesFrom("Other")).rejects.toBe(failure);
      expect(scroll).not.toHaveBeenCalled();
      expect(modals).not.toHaveBeenCalled();
    } finally {
      ui.mockRestore();
      scroll.mockRestore();
      modals.mockRestore();
    }
  });

  for (const releaseHierarchyFirst of [true, false]) {
    test(`preserves invocation order when ${releaseHierarchyFirst ? "hierarchy" : "event"} gate releases first`, async () => {
      const eventGate = deferred();
      const eventStarted = deferred();
      const hierarchyGate = deferred();
      const originalTransaction = repository.runInTransaction.bind(repository);
      const originalLookup = repository.getNodeByFingerprint.bind(repository);
      let firstTransaction = true;
      let hierarchyLookupStarted = false;
      spyOn(repository, "runInTransaction").mockImplementation(async (fn) => {
        if (firstTransaction) {
          firstTransaction = false;
          eventStarted.resolve();
          await eventGate.promise;
        }
        return originalTransaction(fn);
      });
      spyOn(repository, "getNodeByFingerprint").mockImplementation(async (appId, hash) => {
        hierarchyLookupStarted = true;
        await hierarchyGate.promise;
        return originalLookup(appId, hash);
      });

      const eventWrite = manager.recordNavigationEvent({ destination: "New", timestamp: 4000 });
      await eventStarted.promise;
      const hierarchyWrite = manager.recordHierarchyNavigation({
        packageName: appId,
        fromFingerprint: null,
        toFingerprint: "fp_home",
        timestamp: 5000,
      });
      expect(hierarchyLookupStarted).toBe(false);

      if (releaseHierarchyFirst) {
        hierarchyGate.resolve();
        eventGate.resolve();
      } else {
        eventGate.resolve();
        hierarchyGate.resolve();
      }
      await Promise.all([eventWrite, hierarchyWrite]);

      expect(manager.getCurrentScreen()).toBe("Home");
      const edges = await repository.getEdges(appId);
      expect(edges.some((edge) => edge.from_screen === "Other" && edge.to_screen === "New")).toBe(
        true,
      );
    });
  }

  test("a rejected write does not block the next navigation event", async () => {
    const originalTransaction = repository.runInTransaction.bind(repository);
    let rejectNext = true;
    spyOn(repository, "runInTransaction").mockImplementation((fn) => {
      if (rejectNext) {
        rejectNext = false;
        return Promise.reject(new Error("injected transaction failure"));
      }
      return originalTransaction(fn);
    });

    const failed = manager.recordNavigationEvent({ destination: "Failed", timestamp: 4000 });
    const next = manager.recordNavigationEvent({ destination: "Recovered", timestamp: 5000 });
    await expect(failed).rejects.toThrow("injected transaction failure");
    await next;
    expect(manager.getCurrentScreen()).toBe("Recovered");
    const edges = await repository.getEdges(appId);
    expect(
      edges.some((edge) => edge.from_screen === "Other" && edge.to_screen === "Recovered"),
    ).toBe(true);
  });

  test("times out a stuck write, warns once, and releases the next write", async () => {
    const timer = new FakeTimer();
    const bounded = NavigationGraphManager.createForTesting(
      repository,
      new TestCoverageRepository(undefined, harness.db),
      timer,
      undefined,
      50,
    );
    await bounded.setCurrentApp(appId);
    const gate = deferred();
    const started = deferred();
    const originalTransaction = repository.runInTransaction.bind(repository);
    let first = true;
    const transactionSpy = spyOn(repository, "runInTransaction").mockImplementation(async (fn) => {
      if (first) {
        first = false;
        started.resolve();
        await gate.promise;
      }
      return originalTransaction(fn);
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);

    try {
      const stuck = bounded.recordNavigationEvent({ destination: "Stuck", timestamp: 4000 });
      void stuck.catch(() => undefined);
      await started.promise;
      const next = bounded.recordNavigationEvent({ destination: "Recovered", timestamp: 5000 });
      timer.advanceTime(50);
      await expect(stuck).rejects.toBeInstanceOf(ActionableError);
      await expect(stuck).rejects.toThrow("Navigation write recordNavigationEvent timed out");
      await next;
      expect(bounded.getCurrentScreen()).toBe("Recovered");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      warn.mockRestore();
      transactionSpy.mockRestore();
    }
  });

  test("late event completion cannot replace a newer screen", async () => {
    const timer = new FakeTimer();
    const bounded = NavigationGraphManager.createForTesting(
      repository,
      new TestCoverageRepository(undefined, harness.db),
      timer,
      undefined,
      50,
    );
    await bounded.setCurrentApp(appId);
    const gate = deferred();
    const started = deferred();
    const completed = deferred();
    const originalTransaction = repository.runInTransaction.bind(repository);
    let first = true;
    spyOn(repository, "runInTransaction").mockImplementation(async (fn) => {
      const wasFirst = first;
      if (first) {
        first = false;
        started.resolve();
        await gate.promise;
      }
      const result = await originalTransaction(fn);
      if (wasFirst) {
        completed.resolve();
      }
      return result;
    });
    const stale = bounded.recordNavigationEvent({ destination: "A", timestamp: 4000 });
    void stale.catch(() => undefined);
    await started.promise;
    timer.advanceTime(50);
    await expect(stale).rejects.toThrow("timed out");
    await bounded.recordNavigationEvent({ destination: "B", timestamp: 5000 });
    gate.resolve();
    await completed.promise;
    await Promise.resolve();
    expect(bounded.getCurrentScreen()).toBe("B");
    expect(bounded.getCurrentAppId()).toBe(appId);
    expect(await repository.getNode(appId, "A")).toBeDefined();
  });

  test("a settling write clears its deadline without warning", async () => {
    const timer = new FakeTimer();
    const bounded = NavigationGraphManager.createForTesting(
      repository,
      new TestCoverageRepository(undefined, harness.db),
      timer,
      undefined,
      50,
    );
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      warn.mockClear();
      await bounded.setCurrentApp(appId);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      timer.advanceTime(50);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
