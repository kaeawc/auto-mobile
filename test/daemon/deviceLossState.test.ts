import { describe, expect, test } from "bun:test";
import { DeviceLossState } from "../../src/daemon/deviceLossState";

const collectionKeys = [
  "misses",
  "missIncarnations",
  "confirmedDisconnectedIds",
  "forceDisconnectedIds",
  "forceDisconnectedGenerations",
  "offlineRecoveryAttemptedIds",
  "offlineRecoveryAttemptedIncarnations",
  "offlineEpisodes",
] as const;

describe("DeviceLossState", () => {
  test("starts with eight empty, independent collections", () => {
    const state = new DeviceLossState();
    const collections = collectionKeys.map((key) => state[key]);

    expect(new Set(collections).size).toBe(8);
    for (const collection of collections) {
      expect(collection.size).toBe(0);
    }
  });

  test("does not share collections between instances", () => {
    const first = new DeviceLossState();
    const second = new DeviceLossState();

    for (const key of collectionKeys) {
      expect(first[key]).not.toBe(second[key]);
    }
    first.misses.set("device", 1);
    first.missIncarnations.set("device", "incarnation");
    first.confirmedDisconnectedIds.add("device");
    first.forceDisconnectedIds.add("device");
    first.forceDisconnectedGenerations.set("device", 1);
    first.offlineRecoveryAttemptedIds.add("device");
    first.offlineRecoveryAttemptedIncarnations.set("device", 1);
    first.offlineEpisodes.set("device", { incarnation: 1, sinceMs: 0 });
    for (const key of collectionKeys) {
      expect(second[key].size).toBe(0);
    }
  });

  test("exposes replacement offline recovery collections through the same state object", () => {
    const state = new DeviceLossState();
    const readIds = () => state.offlineRecoveryAttemptedIds;
    const readIncarnations = () => state.offlineRecoveryAttemptedIncarnations;
    const oldIds = readIds();
    const oldIncarnations = readIncarnations();
    const ids = new Set(["device"]);
    const incarnations = new Map<string, number | string>([["device", "replacement"]]);

    state.offlineRecoveryAttemptedIds = ids;
    state.offlineRecoveryAttemptedIncarnations = incarnations;

    expect(readIds()).toBe(ids);
    expect(readIncarnations()).toBe(incarnations);
    expect(oldIds.size).toBe(0);
    expect(oldIncarnations.size).toBe(0);
  });

  test("retains seeded collections and initializes omitted collections independently", () => {
    const seed = new DeviceLossState();
    seed.forceDisconnectedIds.add("device");
    seed.missIncarnations.set("device", 2);
    const seeded = new DeviceLossState(seed);

    for (const key of collectionKeys) {
      expect(seeded[key]).toBe(seed[key]);
    }
    expect(seeded.forceDisconnectedIds.has("device")).toBe(true);
    expect(seeded.missIncarnations.get("device")).toBe(2);

    const partial = new DeviceLossState({ forceDisconnectedIds: seed.forceDisconnectedIds });
    expect(partial.forceDisconnectedIds).toBe(seed.forceDisconnectedIds);
    for (const key of collectionKeys.filter((key) => key !== "forceDisconnectedIds")) {
      expect(partial[key].size).toBe(0);
      expect(partial[key]).not.toBe(seed[key]);
    }
  });
});
