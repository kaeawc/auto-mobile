import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { FailureAnalyticsRepository, type RecordFailureInput } from "../../src/db/failureAnalyticsRepository";
import { NavigationRepository } from "../../src/db/navigationRepository";
import { PredictionHistoryRepository, type TransitionKey } from "../../src/db/predictionHistoryRepository";
import { TestCoverageRepository } from "../../src/db/testCoverageRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { runConcurrentSameKeyStress } from "./concurrencyStressHelper";
import { createTestDatabase } from "./testDbHelper";

describe("DB concurrency RMW audit", () => {
  const N = 16;
  const openDbs: Kysely<Database>[] = [];

  function tablePathsInSection(markdown: string, heading: string): string[] {
    const section = markdown.split(`## ${heading}`)[1]?.split("\n## ")[0];
    if (!section) {
      throw new Error(`Missing audit section: ${heading}`);
    }
    return section
      .split("\n")
      .map(line => line.match(/^\| `([^`]+)` \|/)?.[1])
      .filter((path): path is string => path !== undefined);
  }

  afterEach(async () => {
    await Promise.all(openDbs.splice(0).map(db => db.destroy()));
  });

  async function openDb(): Promise<Kysely<Database>> {
    const db = await createTestDatabase();
    openDbs.push(db);
    return db;
  }

  function makeFailureInput(overrides: Partial<RecordFailureInput> = {}): RecordFailureInput {
    return {
      type: "crash",
      signature: "audit.signature",
      title: "Audit failure",
      message: "Concurrent failure",
      severity: "critical",
      occurrence: {
        deviceModel: "Pixel 7",
        os: "Android 14",
        appVersion: "1.0.0",
        sessionId: "session-audit",
      },
      ...overrides,
    };
  }

  test("documents guarded and follow-up RMW paths", () => {
    const audit = readFileSync(
      new URL("../../docs/design-docs/db-concurrency-rmw-audit.md", import.meta.url),
      "utf8"
    );

    const guardedPaths = [
      ["NavigationRepository.getOrCreateApp", "Atomic upsert on `navigation_apps.app_id`"],
      ["NavigationRepository.getOrCreateNode", "Atomic upsert on `(app_id, screen_name)`"],
      ["NavigationRepository.getOrCreateUIElement", "guarded by `db.transaction()`"],
      ["NavigationRepository.getOrCreateFingerprint", "Atomic upsert on `(app_id, fingerprint_hash)`"],
      ["NavigationRepository.addOrUpdateSuggestion", "Atomic upsert on `(app_id, fingerprint_hash)`"],
      ["FailureAnalyticsRepository.recordFailure", "Method-level transaction"],
      ["TestCoverageRepository.getOrCreateSession", "Atomic upsert on `session_uuid`"],
      ["TestCoverageRepository.recordNodeVisit", "Atomic upsert on `(session_id, node_id)`"],
      ["TestCoverageRepository.recordEdgeTraversal", "Atomic upsert on `(session_id, edge_id)`"],
      [
        "PredictionHistoryRepository.upsertTransitionStats",
        "Atomic upsert on `(app_id, from_screen, to_screen, tool_name, tool_args)`",
      ],
      ["InstalledAppsRepository.replaceInstalledApps", "guarded by a transaction"],
      ["InstalledAppsRepository.upsertInstalledApp", "Atomic upsert on `(device_id, user_id, package_name)`"],
      ["DeviceSessionRepository.upsertActiveSession", "Atomic upsert on `session_uuid`"],
      ["AppearanceConfigRepository.setConfig", "Atomic upsert on the singleton `key`"],
      ["DeviceSnapshotConfigRepository.setConfig", "Atomic upsert on the singleton `key`"],
      ["VideoRecordingConfigRepository.setConfig", "Atomic upsert on the singleton `key`"],
    ] as const;

    expect(tablePathsInSection(audit, "Guarded Paths")).toEqual(
      guardedPaths.map(([path]) => path)
    );
    for (const [path, strategy] of guardedPaths) {
      expect(audit).toContain(`| \`${path}\` |`);
      expect(audit).toContain(strategy);
    }

    const followUpPaths = [
      ["SqliteFeatureFlagRepository.ensureFlags", "Concurrent first initialization can race"],
      ["SqliteFeatureFlagRepository.upsertFlag", "Concurrent first writes can race"],
      ["recordStorageEvent", "Concurrent inserts can observe the same prior value"],
      ["NavigationRepository.promoteSuggestion", "the repository method itself does not enforce that contract"],
    ] as const;

    expect(tablePathsInSection(audit, "Follow-Up Candidates")).toEqual(
      followUpPaths.map(([path]) => path)
    );
    for (const [path, status] of followUpPaths) {
      expect(audit).toContain(`| \`${path}\` |`);
      expect(audit).toContain(status);
    }

    const adjacentFollowUpPaths = [
      ["ThresholdManager.getOrCreateThresholds", "Concurrent callers can insert duplicate threshold samples"],
      ["MemoryThresholdManager.getOrCreateThresholds", "Concurrent callers can insert duplicate threshold samples"],
      ["BaselineManager.saveBaseline", "Concurrent first saves can race on the unique key"],
      ["MemoryBaselineManager.updateBaseline", "Concurrent updates can lose samples/averages"],
      ["ThresholdManager.updateThresholdWeight", "Concurrent updates can lose weight adjustments"],
      ["MemoryThresholdManager.updateThresholdWeight", "Concurrent updates can lose weight adjustments"],
    ] as const;

    expect(tablePathsInSection(audit, "Adjacent Follow-Up Candidates")).toEqual(
      adjacentFollowUpPaths.map(([path]) => path)
    );
    for (const [path, status] of adjacentFollowUpPaths) {
      expect(audit).toContain(`| \`${path}\` |`);
      expect(audit).toContain(status);
    }
  });

  test("stresses guarded get-or-create and increment paths through the real dialect mutex", async () => {
    const db = await openDb();
    const navigation = new NavigationRepository(db);
    await navigation.getOrCreateApp("com.example.audit");

    const nodeResults = await runConcurrentSameKeyStress({
      count: N,
      act: () => navigation.getOrCreateNode("com.example.audit", "Home", 1000),
    });
    const nodes = await navigation.getNodes("com.example.audit");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].visit_count).toBe(N);
    expect(new Set(nodeResults.map(node => node.id)).size).toBe(1);

    const uiResults = await runConcurrentSameKeyStress({
      count: N,
      act: index =>
        navigation.getOrCreateUIElement(
          "com.example.audit",
          { text: "Login", resourceId: "login_button" },
          2000 + index
        ),
    });
    const uiElements = await db
      .selectFrom("ui_elements")
      .selectAll()
      .where("app_id", "=", "com.example.audit")
      .execute();
    expect(uiElements).toHaveLength(1);
    expect(new Set(uiResults.map(element => element.id)).size).toBe(1);

    const timer = new FakeTimer();
    timer.setCurrentTime(3000);
    const failures = new FailureAnalyticsRepository(timer, db);
    await runConcurrentSameKeyStress({
      count: N,
      act: index =>
        failures.recordFailure(
          makeFailureInput({
            occurrence: {
              deviceModel: "Pixel 7",
              os: "Android 14",
              appVersion: "1.0.0",
              sessionId: `session-${index}`,
            },
          })
        ),
    });
    const failureGroups = await db.selectFrom("failure_groups").selectAll().execute();
    const failureOccurrences = await db.selectFrom("failure_occurrences").selectAll().execute();
    expect(failureGroups).toHaveLength(1);
    expect(failureGroups[0].total_count).toBe(N);
    expect(failureGroups[0].unique_sessions).toBe(N);
    expect(failureOccurrences).toHaveLength(N);

    const coverage = new TestCoverageRepository(timer, db);
    const sessions = await runConcurrentSameKeyStress({
      count: N,
      act: () => coverage.getOrCreateSession("coverage-session", "com.example.audit"),
    });
    expect(new Set(sessions.map(session => session.id)).size).toBe(1);
    await runConcurrentSameKeyStress({
      count: N,
      act: () => coverage.recordNodeVisit(sessions[0].id, nodes[0].id, 4000),
    });
    const nodeCoverage = await db.selectFrom("test_node_coverage").selectAll().execute();
    const coverageSession = await db
      .selectFrom("test_coverage_sessions")
      .selectAll()
      .where("id", "=", sessions[0].id)
      .executeTakeFirstOrThrow();
    expect(nodeCoverage).toHaveLength(1);
    expect(nodeCoverage[0].visit_count).toBe(N);
    expect(coverageSession.total_nodes_visited).toBe(N);

    const predictions = new PredictionHistoryRepository(db);
    const transition: TransitionKey = {
      appId: "com.example.audit",
      fromScreen: "Home",
      toScreen: "Details",
      toolName: "tapOn",
      toolArgs: { text: "Details" },
    };
    await runConcurrentSameKeyStress({
      count: N,
      act: () => predictions.upsertTransitionStats(transition, 0.75, true),
    });
    const stats = await db.selectFrom("prediction_transition_stats").selectAll().execute();
    expect(stats).toHaveLength(1);
    expect(stats[0].attempts).toBe(N);
    expect(stats[0].successes).toBe(N);
    expect(stats[0].total_confidence).toBe(0.75 * N);
  });
});
