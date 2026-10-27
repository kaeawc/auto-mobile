import { describe, expect, test } from "bun:test";
import {
  evaluateDeviceDisconnects,
  type DisconnectCandidateIncarnation,
  type OfflineEpisode,
} from "../../src/daemon/disconnectMonitor";
import { observeMissingDevice } from "../../src/daemon/missingDeviceLiveness";
import type { Platform } from "../../src/models";
import type { DiscoverySource } from "../../src/utils/discoverySource";
import { FakeTimer } from "../fakes/FakeTimer";

const DEVICE = "sim-held";
const BUDGET_MS = 20_000;

function harness(platform: Platform = "ios") {
  const timer = new FakeTimer();
  const misses = new Map<string, number>();
  const incarnations = new Map<string, DisconnectCandidateIncarnation>([[DEVICE, 1]]);
  const countedIncarnations = new Map<string, DisconnectCandidateIncarnation>();
  const episodes = new Map<string, OfflineEpisode>();
  const candidates = new Set([DEVICE]);
  const source = platform === "ios" ? "ios-simulator" : "android";
  const evaluate = (
    observation: "missing" | "present" | "source-unavailable",
    anotherSourceSucceeded = false,
  ) => {
    const succeeded = observation !== "source-unavailable";
    return evaluateDeviceDisconnects({
      deviceDisconnectMisses: misses,
      deviceDisconnectMissIncarnations: countedIncarnations,
      candidateIncarnations: incarnations,
      confirmedDisconnectedDeviceIds: new Set(),
      candidateDeviceIds: candidates,
      candidatePlatforms: new Map([[DEVICE, platform]]),
      bootedDeviceIds: new Set(observation === "present" ? [DEVICE] : []),
      succeededPlatforms: new Set(succeeded || anotherSourceSucceeded ? [platform] : []),
      succeededSources: new Set<DiscoverySource>(
        succeeded ? [source] : anotherSourceSucceeded ? ["ios-physical"] : [],
      ),
      offlineEpisodes: episodes,
      nowMs: timer.now(),
      missingSimulatorBudgetMs: BUDGET_MS,
    });
  };
  return { timer, misses, incarnations, countedIncarnations, episodes, candidates, evaluate };
}

describe("disconnect monitor source-unavailable evidence (#13793)", () => {
  test("missing, missing, source-unavailable, missing confirms loss with FakeTimer", () => {
    const h = harness();
    for (const observation of ["missing", "missing", "source-unavailable", "missing"] as const) {
      h.timer.advanceTime(5_000);
      const result = h.evaluate(observation);
      if (h.timer.now() === 20_000) {
        expect(result.disconnected).toEqual([DEVICE]);
      } else {
        expect(result.disconnected).toEqual([]);
      }
    }
  });

  test.each([false, true])(
    "source failure holds the miss incarnation, other source success=%s",
    (otherSucceeded) => {
      const h = harness();
      h.evaluate("missing");
      h.evaluate("missing");
      const result = h.evaluate("source-unavailable", otherSucceeded);
      expect(result.disconnected).toEqual([]);
      expect(result.missed).toEqual([]);
      expect(h.misses.get(DEVICE)).toBe(2);
      expect(h.countedIncarnations.get(DEVICE)).toBe(1);
      expect(h.evaluate("missing").disconnected).toEqual([DEVICE]);
    },
  );

  test.each([false, true])(
    "the injected simulator budget resolves even on an unknown sweep, other source success=%s",
    (otherSucceeded) => {
      const h = harness();
      h.evaluate("missing");
      h.timer.advanceTime(BUDGET_MS - 1);
      expect(h.evaluate("source-unavailable", otherSucceeded).disconnected).toEqual([]);
      expect(h.misses.get(DEVICE)).toBe(1);
      h.timer.advanceTime(1);
      const result = h.evaluate("source-unavailable", otherSucceeded);
      expect(result.disconnected).toEqual([DEVICE]);
      expect(result.skippedAllDiscoveryFailed).toBe(false);
      expect(result.missed).toEqual([{ deviceId: DEVICE, misses: 3, budgetExhausted: true }]);
    },
  );

  test("a successful missing sweep also resolves at the budget boundary", () => {
    const h = harness();
    h.evaluate("missing");
    h.timer.advanceTime(BUDGET_MS);
    expect(h.evaluate("missing").disconnected).toEqual([DEVICE]);
  });

  test("unavailable-only sweeps cannot start the absence clock", () => {
    const h = harness();
    h.evaluate("source-unavailable");
    h.timer.advanceTime(10 * BUDGET_MS);
    expect(h.evaluate("source-unavailable").disconnected).toEqual([]);
    expect(h.episodes.size).toBe(0);
    expect(h.misses.size).toBe(0);
  });

  test("present clears held misses, incarnation and budget before a new absence", () => {
    const h = harness();
    h.evaluate("missing");
    h.evaluate("source-unavailable");
    h.timer.advanceTime(BUDGET_MS);
    h.evaluate("present");
    expect(h.misses.size).toBe(0);
    expect(h.countedIncarnations.size).toBe(0);
    expect(h.episodes.size).toBe(0);
    expect(h.evaluate("missing").disconnected).toEqual([]);
    expect(h.evaluate("source-unavailable").disconnected).toEqual([]);
  });

  test("a replacement incarnation cannot inherit misses or an expired absence budget", () => {
    const h = harness();
    h.evaluate("missing");
    h.evaluate("missing");
    h.timer.advanceTime(BUDGET_MS);
    h.incarnations.set(DEVICE, 2);
    expect(h.evaluate("source-unavailable").disconnected).toEqual([]);
    expect(h.misses.size).toBe(0);
    expect(h.countedIncarnations.size).toBe(0);
    expect(h.episodes.size).toBe(0);
    expect(h.evaluate("missing").disconnected).toEqual([]);
  });

  test("leaving the candidate set retires the absence budget", () => {
    const h = harness();
    h.evaluate("missing");
    h.candidates.clear();
    h.evaluate("source-unavailable");
    h.timer.advanceTime(BUDGET_MS);
    h.candidates.add(DEVICE);
    expect(h.evaluate("source-unavailable").disconnected).toEqual([]);
    expect(h.episodes.size).toBe(0);
    expect(h.misses.size).toBe(0);
  });

  test("Android holds unknown misses without acquiring the simulator time bound", () => {
    const h = harness("android");
    h.evaluate("missing");
    h.timer.advanceTime(10 * BUDGET_MS);
    expect(h.evaluate("source-unavailable").disconnected).toEqual([]);
    expect(h.misses.get(DEVICE)).toBe(1);
    expect(h.episodes.size).toBe(0);
    expect(h.evaluate("missing").disconnected).toEqual([]);
    expect(h.evaluate("missing").disconnected).toEqual([DEVICE]);
  });

  test("the shared observer holds unknown evidence but only presence resets it", () => {
    const misses = new Map<string, number>();
    expect(observeMissingDevice(misses, DEVICE, "source-unavailable")).toEqual({
      misses: 0,
      confirmedGone: false,
    });
    observeMissingDevice(misses, DEVICE, "missing");
    expect(observeMissingDevice(misses, DEVICE, "source-unavailable")).toEqual({
      misses: 1,
      confirmedGone: false,
    });
    expect(observeMissingDevice(misses, DEVICE, "present")).toEqual({
      misses: 0,
      confirmedGone: false,
    });
    expect(misses.size).toBe(0);
  });
});
