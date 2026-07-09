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
      ["SqliteFeatureFlagRepository.ensureFlags", "Atomic insert with `ON CONFLICT(key) DO NOTHING`"],
      ["SqliteFeatureFlagRepository.upsertFlag", "Atomic upsert on `feature_flags.key`"],
      ["recordStorageEvent", "omitted previous-value lookup plus insert runs in one transaction"],
      ["NavigationRepository.promoteSuggestion", "Direct repository calls open a transaction"],
    ] as const;

    expect(tablePathsInSection(audit, "Guarded Paths")).toEqual(
      guardedPaths.map(([path]) => path)
    );
    for (const [path, strategy] of guardedPaths) {
      expect(audit).toContain(`| \`${path}\` |`);
      expect(audit).toContain(strategy);
    }

    expect(tablePathsInSection(audit, "Follow-Up Candidates")).toEqual([]);
    expect(audit).toContain("No unguarded repository RMW follow-up candidates remain from #3415.");

    const guardedAdjacentPaths = [
      ["ThresholdManager.getOrCreateThresholds", "runs in a short transaction"],
      ["MemoryThresholdManager.getOrCreateThresholds", "runs in a short transaction"],
      ["BaselineManager.saveBaseline", "Atomic upsert on the unique `screen_id`"],
      ["MemoryBaselineManager.updateBaseline", "sample count increments and EMA calculations happen in SQL"],
      ["ThresholdManager.updateThresholdWeight", "Atomic SQL update of the latest `(device_id, session_id)`"],
      ["MemoryThresholdManager.updateThresholdWeight", "Atomic SQL update of the latest `(device_id, package_name)`"],
    ] as const;

    expect(tablePathsInSection(audit, "Guarded Adjacent Paths")).toEqual(
      guardedAdjacentPaths.map(([path]) => path)
    );
    for (const [path, status] of guardedAdjacentPaths) {
      expect(audit).toContain(`| \`${path}\` |`);
      expect(audit).toContain(status);
    }

    expect(tablePathsInSection(audit, "Adjacent Follow-Up Candidates")).toEqual([]);
    expect(audit).toContain("No unguarded adjacent manager RMW follow-up candidates remain from #3415.");
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
