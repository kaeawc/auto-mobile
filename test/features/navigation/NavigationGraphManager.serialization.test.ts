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
    );
    await manager.setCurrentApp(appId);
    await manager.recordNavigationEvent({ destination: "Home", timestamp: 1000 });
    await manager.recordHierarchyNavigation({
      fromFingerprint: null,
      toFingerprint: "fp_home",
      timestamp: 1200,
    });
    await manager.recordNavigationEvent({ destination: "Other", timestamp: 3000 });
  });

  afterAll(async () => {
    await harness.dispose();
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
