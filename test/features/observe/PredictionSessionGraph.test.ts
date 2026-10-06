import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { createTestDatabase } from "../../db/testDbHelper";
import type { Database } from "../../../src/db/types";
import { NavigationRepository } from "../../../src/db/navigationRepository";
import { PredictionHistoryRepository } from "../../../src/db/predictionHistoryRepository";
import type { PredictionOutcomeRecord } from "../../../src/db/predictionHistoryRepository";
import { TestCoverageRepository } from "../../../src/db/testCoverageRepository";
import { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import {
  createNavigationGraphResolver,
  type NavigationDeviceRef,
} from "../../../src/features/navigation/deviceNavigationGraph";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { PredictionAnalyzer } from "../../../src/features/observe/PredictionAnalyzer";
import { PredictiveUIState } from "../../../src/features/observe/PredictiveUIState";
import type { Element, ObserveResult } from "../../../src/models";
import { PortManager } from "../../../src/utils/PortManager";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeElementParser } from "../../fakes/FakeElementParser";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

// With --predictive-ui, observe predictions and prediction outcomes must read the graph the
// device's navigation events are recorded on: the bound session's manager, not the global
// singleton (#10197).

const APP = "com.example.app";
const SESSION_A_DEVICE: NavigationDeviceRef = { deviceId: "emulator-5554", platform: "android" };
const SESSION_B_DEVICE: NavigationDeviceRef = { deviceId: "emulator-5556", platform: "android" };
const UNBOUND_DEVICE: NavigationDeviceRef = { deviceId: "emulator-5558", platform: "android" };

const observation: ObserveResult = { updatedAt: 1, viewHierarchy: { hierarchy: {} } };

function interactable(text: string): Element {
  return { text, "resource-id": text.toLowerCase(), clickable: true };
}

describe("prediction reads follow the device's bound session graph (#10197)", () => {
  let harness: InMemoryNavManagerHarness;
  const sessionDbs: Kysely<Database>[] = [];
  const boundSessions = new Map<string, string>();
  const resolver = createNavigationGraphResolver(
    (device) => boundSessions.get(device.deviceId) ?? null,
  );

  async function sessionManager(sessionId: string): Promise<NavigationGraphManager> {
    const db = await createTestDatabase();
    sessionDbs.push(db);
    const manager = NavigationGraphManager.createForTesting(
      new NavigationRepository(db),
      new TestCoverageRepository(undefined, db),
      undefined,
      sessionId,
    );
    NavigationGraphManager.setInstanceForSessionForTesting(sessionId, manager);
    return manager;
  }

  /** Home -(tapOn text)-> Detail -> Home: leaves `manager` on Home with one tapOn edge from it. */
  async function recordRoundTrip(manager: NavigationGraphManager, text: string): Promise<void> {
    let timestamp = 1_000;
    const arrive = (destination: string) =>
      manager.recordNavigationEvent({
        destination,
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: (timestamp += 100),
        sequenceNumber: timestamp,
        applicationId: APP,
      });
    await manager.setCurrentApp(APP);
    await arrive("Home");
    manager.recordToolCall("tapOn", { text });
    await arrive("Detail");
    await arrive("Home");
  }

  function predictiveState(buttonText: string): PredictiveUIState {
    const state = new PredictiveUIState(resolver);
    state["historyRepository"] = new PredictionHistoryRepository(harness.db);
    const parser = new FakeElementParser();
    parser.nextFlattenedElements = [{ element: interactable(buttonText), index: 0, depth: 0 }];
    state["elementParser"] = parser;
    return state;
  }

  const predictedScreens = (state: PredictiveUIState, device?: NavigationDeviceRef) =>
    state
      .generate(observation, device)
      .then((predictions) => predictions?.likelyActions.map((a) => [a.action, a.predictedScreen]));

  beforeEach(async () => {
    harness = await installInMemoryNavManager();
    boundSessions.clear();
    boundSessions.set(SESSION_A_DEVICE.deviceId, "session-a");
    boundSessions.set(SESSION_B_DEVICE.deviceId, "session-b");
  });

  afterEach(async () => {
    await harness.dispose();
    await Promise.all(sessionDbs.splice(0).map((db) => db.destroy()));
  });

  test("a session that recorded transitions gets predictions from its own graph", async () => {
    await recordRoundTrip(await sessionManager("session-a"), "Open");
    await harness.db.deleteFrom("prediction_transition_stats").execute();

    expect(await predictedScreens(predictiveState("Open"), SESSION_A_DEVICE)).toEqual([
      ["tapOn", "Detail"],
    ]);
  });

  test("the global manager has nothing for a session's device, as the old read saw", async () => {
    await recordRoundTrip(await sessionManager("session-a"), "Open");

    // No device: the global manager, which never learned the session's screen.
    expect(await predictedScreens(predictiveState("Open"))).toBeUndefined();
  });

  test("a different session does not see another session's graph", async () => {
    await recordRoundTrip(await sessionManager("session-a"), "Open");
    await sessionManager("session-b");

    expect(await predictedScreens(predictiveState("Open"), SESSION_B_DEVICE)).toBeUndefined();
  });

  test("a global manager on another screen of the same app does not leak into the session", async () => {
    await recordRoundTrip(await sessionManager("session-a"), "Open");
    await recordRoundTrip(harness.manager, "Other");

    // The session's own edge matches; the global graph's "Other" edge never does.
    expect(await predictedScreens(predictiveState("Open"), SESSION_A_DEVICE)).toEqual([
      ["tapOn", "Detail"],
    ]);
    expect(await predictedScreens(predictiveState("Other"), SESSION_A_DEVICE)).toBeUndefined();
  });

  test("an unbound device uses the global manager as before", async () => {
    await recordRoundTrip(harness.manager, "Open");

    expect(await predictedScreens(predictiveState("Open"), UNBOUND_DEVICE)).toEqual([
      ["tapOn", "Detail"],
    ]);
    expect(await predictedScreens(predictiveState("Open"))).toEqual([["tapOn", "Detail"]]);
  });
});

describe("prediction outcomes are recorded on the graph that produced the prediction (#10197)", () => {
  let harness: InMemoryNavManagerHarness;
  let sessionDb: Kysely<Database>;
  let sessionGraph: NavigationGraphManager;
  const boundSessions = new Map<string, string>();
  const resolver = createNavigationGraphResolver(
    (device) => boundSessions.get(device.deviceId) ?? null,
  );

  class RecordingHistory {
    outcomes: PredictionOutcomeRecord[] = [];
    async recordOutcome(outcome: PredictionOutcomeRecord): Promise<void> {
      this.outcomes.push(outcome);
    }
  }

  beforeEach(async () => {
    harness = await installInMemoryNavManager();
    sessionDb = await createTestDatabase();
    sessionGraph = NavigationGraphManager.createForTesting(
      new NavigationRepository(sessionDb),
      new TestCoverageRepository(undefined, sessionDb),
      undefined,
      "session-a",
    );
    NavigationGraphManager.setInstanceForSessionForTesting("session-a", sessionGraph);
    boundSessions.clear();
    boundSessions.set(SESSION_A_DEVICE.deviceId, "session-a");
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  });

  afterEach(async () => {
    await harness.dispose();
    await sessionDb.destroy();
  });

  async function moveSessionTo(screen: string, timestamp: number): Promise<void> {
    await sessionGraph.setCurrentApp(APP);
    await sessionGraph.recordNavigationEvent({
      destination: screen,
      source: "TEST",
      arguments: {},
      metadata: {},
      timestamp,
      sequenceNumber: timestamp,
      applicationId: APP,
    });
  }

  function visualChange(device: NavigationDeviceRef): BaseVisualChange {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const change = new BaseVisualChange(
      { name: "test-device", ...device },
      new FakeAdbExecutor(),
      timer,
    );
    change.navigationGraphResolver = resolver;
    return change;
  }

  const tapOpen = { toolName: "tapOn", toolArgs: { text: "Open" } };

  test("buildPredictionContext reads the bound session's app and screen", async () => {
    await moveSessionTo("Home", 1_000);

    const context = visualChange(SESSION_A_DEVICE)["buildPredictionContext"](tapOpen);

    expect(context).toMatchObject({ appId: APP, fromScreen: "Home", toolName: "tapOn" });
    expect(context?.navigationGraph).toBe(sessionGraph);
  });

  test("buildPredictionContext on an unbound device reads the global manager", async () => {
    await harness.manager.setCurrentApp(APP);
    await harness.manager.recordNavigationEvent({
      destination: "GlobalHome",
      source: "TEST",
      arguments: {},
      metadata: {},
      timestamp: 1_000,
      sequenceNumber: 1,
      applicationId: APP,
    });

    const context = visualChange(UNBOUND_DEVICE)["buildPredictionContext"](tapOpen);

    expect(context).toMatchObject({ appId: APP, fromScreen: "GlobalHome" });
    expect(context?.navigationGraph).toBe(harness.manager);
  });

  test("a device with no session graph screen yields no context", () => {
    expect(visualChange(SESSION_A_DEVICE)["buildPredictionContext"](tapOpen)).toBeUndefined();
  });

  test("the outcome compares the landing screen on the session graph that built the context", async () => {
    await moveSessionTo("Home", 1_000);
    const context = visualChange(SESSION_A_DEVICE)["buildPredictionContext"](tapOpen);
    await moveSessionTo("Detail", 2_000);
    const history = new RecordingHistory();
    // The global manager never learned any screen, as in a session-bound client.
    expect(harness.manager.getCurrentScreen()).toBeNull();
    const analyzer = new PredictionAnalyzer(history);
    const previous: ObserveResult = {
      ...observation,
      predictions: {
        likelyActions: [
          {
            action: "tapOn",
            target: { text: "Open" },
            predictedScreen: "Detail",
            predictedElements: [],
            confidence: 0.6,
          },
        ],
        interactableElements: [],
      },
    };

    await analyzer.recordOutcomeForAction(previous, observation, context!);

    expect(history.outcomes).toHaveLength(1);
    expect(history.outcomes[0]).toMatchObject({
      appId: APP,
      fromScreen: "Home",
      predictedScreen: "Detail",
      actualScreen: "Detail",
      correct: true,
    });
  });
});
