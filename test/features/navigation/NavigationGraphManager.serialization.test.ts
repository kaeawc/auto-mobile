import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { NavigationRepository } from "../../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../../src/db/testCoverageRepository";
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
});
