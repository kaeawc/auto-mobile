import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { NavigationRepository } from "../../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../../src/db/testCoverageRepository";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

const APP_A = "dev.jasonpearson.automobile.playground";
const APP_B = "com.android.settings";
const SDK_TIME = 1791181941676; // Capture 1791181941976 minus the logged 300ms correlation gap.
const SETTINGS_HASH = "39df1f891792";

describe("hierarchy app identity", () => {
  let harness: InMemoryNavManagerHarness;
  let manager: NavigationGraphManager;
  let repository: NavigationRepository;
  let timer: FakeTimer;

  beforeAll(async () => {
    harness = await installInMemoryNavManager();
  });
  beforeEach(async () => {
    await harness.db
      .deleteFrom("navigation_node_fingerprints")
      .where("app_id", "in", [APP_A, APP_B])
      .execute();
    await new NavigationRepository(harness.db).clearAppGraph(APP_A);
    await new NavigationRepository(harness.db).clearAppGraph(APP_B);
    timer = new FakeTimer();
    timer.setCurrentTime(SDK_TIME);
    repository = new NavigationRepository(harness.db);
    manager = NavigationGraphManager.createForTesting(
      repository,
      new TestCoverageRepository(undefined, harness.db),
      timer,
    );
  });
  afterAll(async () => {
    await harness.dispose();
  });

  async function navigate(appId = APP_A, timestamp = SDK_TIME): Promise<void> {
    timer.setCurrentTime(timestamp);
    await manager.recordNavigationEvent({
      destination: "DemoIndexDestination",
      applicationId: appId,
      timestamp,
      source: "sdk",
      arguments: {},
      metadata: {},
      sequenceNumber: 1,
    });
  }

  async function hierarchy(
    packageName: string | null | undefined,
    gap: number,
    hash = SETTINGS_HASH,
  ): Promise<void> {
    timer.setCurrentTime(SDK_TIME + gap);
    await manager.recordHierarchyNavigation({
      packageName,
      fromFingerprint: null,
      toFingerprint: hash,
      timestamp: timer.now(),
    });
  }

  async function appSnapshot() {
    return {
      app: await harness.db
        .selectFrom("navigation_apps")
        .selectAll()
        .where("app_id", "=", APP_A)
        .execute(),
      nodes: await repository.getNodes(APP_A),
      fingerprints: await harness.db
        .selectFrom("navigation_node_fingerprints")
        .selectAll()
        .where("app_id", "=", APP_A)
        .execute(),
      suggestions: await repository.getSuggestions(APP_A),
      edges: await repository.getEdges(APP_A),
      coverage: await harness.db
        .selectFrom("test_node_coverage")
        .innerJoin("navigation_nodes", "navigation_nodes.id", "test_node_coverage.node_id")
        .selectAll("test_node_coverage")
        .where("navigation_nodes.app_id", "=", APP_A)
        .execute(),
      observations: await harness.db
        .selectFrom("navigation_node_observations")
        .innerJoin(
          "navigation_nodes",
          "navigation_nodes.id",
          "navigation_node_observations.node_id",
        )
        .selectAll("navigation_node_observations")
        .where("navigation_nodes.app_id", "=", APP_A)
        .execute(),
    };
  }

  for (const packageName of [APP_B, null, undefined, "", "   "]) {
    for (const gap of [300, 337, 1300]) {
      test(`foreground switch with package ${String(packageName)} at ${gap}ms never writes A`, async () => {
        await navigate();
        const before = await appSnapshot();
        await hierarchy(packageName, gap);
        expect(await appSnapshot()).toEqual(before);
        expect(manager.getCurrentAppId()).toBe(packageName === APP_B ? APP_B : APP_A);
        expect(manager.getCurrentScreen()).toBe(
          packageName === APP_B ? null : "DemoIndexDestination",
        );
        if (packageName === APP_B) {
          expect(
            await harness.db
              .selectFrom("navigation_apps")
              .selectAll()
              .where("app_id", "=", APP_B)
              .execute(),
          ).toHaveLength(1);
          expect(await repository.getNodes(APP_B)).toEqual([]);
          expect(await repository.getSuggestions(APP_B)).toEqual([]);
          // Returning without a new SDK event must not revive A's pending navigation.
          await hierarchy(APP_A, gap + 1, "returned");
          expect(await repository.getNodeByFingerprint(APP_A, "returned")).toBeUndefined();
        }
      });
    }
  }

  for (const packageName of [null, undefined, ""]) {
    test(`unknown ${String(packageName)} cannot revisit an already correlated A fingerprint`, async () => {
      await navigate();
      await hierarchy(APP_A, 300);
      await manager.startTestSession("identity-test");
      const before = await appSnapshot();
      await hierarchy(packageName, 337);
      expect(await appSnapshot()).toEqual(before);
      expect(manager.getCurrentScreen()).toBe("DemoIndexDestination");
    });
  }

  test("B's known fingerprint and suggestions still record under B alone", async () => {
    await navigate(APP_B, SDK_TIME - 2000);
    await manager.recordHierarchyNavigation({
      packageName: APP_B,
      fromFingerprint: null,
      toFingerprint: SETTINGS_HASH,
      timestamp: SDK_TIME - 1800,
    });
    await navigate();
    const before = await appSnapshot();
    await hierarchy(APP_B, 300);
    expect(await repository.getNodeByFingerprint(APP_B, SETTINGS_HASH)).toMatchObject({
      visit_count: 2,
    });
    await hierarchy(APP_B, 1300, "705d0068d1c6");
    expect(await repository.getSuggestions(APP_B)).toHaveLength(1);
    expect(await appSnapshot()).toEqual(before);
  });

  test("same app correlates with late iOS build context and consumes pending navigation", async () => {
    await navigate();
    manager.setBuildContext({
      appId: APP_A,
      deviceId: "ios-cold-start",
      versionCode: 42,
      contentHash: "late-bundle-hash",
    });
    await hierarchy(APP_A, 300);
    expect(await repository.getNodeByFingerprint(APP_A, SETTINGS_HASH)).toMatchObject({
      screen_name: "DemoIndexDestination",
    });
    await hierarchy(APP_A, 337, "second-fingerprint");
    expect(await repository.getNodeByFingerprint(APP_A, "second-fingerprint")).toBeUndefined();
    expect(await repository.getSuggestions(APP_A)).toHaveLength(1);
  });

  test("same app outside the window does not correlate", async () => {
    await navigate();
    await hierarchy(APP_A, 1300);
    expect(await repository.getNodeByFingerprint(APP_A, SETTINGS_HASH)).toBeUndefined();
    expect(await repository.getSuggestions(APP_A)).toHaveLength(1);
  });
});
