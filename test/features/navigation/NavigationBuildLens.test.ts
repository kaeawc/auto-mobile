import { describe, expect, test } from "bun:test";
import {
  buildKeysEqual,
  diffGraphSummaryByBuild,
  filterGraphSummaryByBuild,
} from "../../../src/features/navigation/NavigationBuildLens";
import type {
  NavigationGraphSummary,
  NavigationProvenanceBuildKey,
} from "../../../src/utils/interfaces/NavigationGraph";

const buildA: NavigationProvenanceBuildKey = {
  packageId: "com.example.app",
  versionCode: 1,
  contentHash: "hash-a",
};
const buildB: NavigationProvenanceBuildKey = {
  packageId: "com.example.app",
  versionCode: 2,
  contentHash: "hash-b",
};
const buildC: NavigationProvenanceBuildKey = {
  packageId: "com.example.app",
  versionCode: 3,
  contentHash: "hash-c",
};

const observed = (buildKey: NavigationProvenanceBuildKey) => ({
  buildKey,
  deviceId: "device-1",
  sessionUuid: "session-1",
  lastSeen: 100,
});

const summary: NavigationGraphSummary = {
  appId: "com.example.app",
  currentScreen: "Both",
  nodes: [
    { id: 1, screenName: "Both", visitCount: 1, provenance: [observed(buildA), observed(buildB)] },
    { id: 2, screenName: "A", visitCount: 1, provenance: [observed(buildA)] },
    { id: 3, screenName: "B", visitCount: 1, provenance: [observed(buildB)] },
    { id: 4, screenName: "C", visitCount: 1, provenance: [observed(buildC)] },
    { id: 5, screenName: "Unknown", visitCount: 1 },
  ],
  edges: [
    {
      id: 1,
      from: "Both",
      to: "Both",
      toolName: null,
      traversalCount: 1,
      provenance: [observed(buildA), observed(buildB)],
    },
    {
      id: 2,
      from: "Both",
      to: "A",
      toolName: null,
      traversalCount: 1,
      provenance: [observed(buildA)],
    },
    {
      id: 3,
      from: "Both",
      to: "B",
      toolName: null,
      traversalCount: 1,
      provenance: [observed(buildB)],
    },
    {
      id: 4,
      from: "Both",
      to: "C",
      toolName: null,
      traversalCount: 1,
      provenance: [observed(buildC)],
    },
    { id: 5, from: "Both", to: "Unknown", toolName: null, traversalCount: 1 },
    { id: 6, from: "Unknown", to: "Both", toolName: null, traversalCount: 1, provenance: [] },
  ],
};

describe("NavigationBuildLens", () => {
  test("build key equality checks every identity field", () => {
    expect(buildKeysEqual(buildA, { ...buildA })).toBe(true);
    expect(buildKeysEqual(buildA, { ...buildA, packageId: "other" })).toBe(false);
    expect(buildKeysEqual(buildA, { ...buildA, versionCode: 2 })).toBe(false);
    expect(buildKeysEqual(buildA, { ...buildA, contentHash: "other" })).toBe(false);
  });

  test("filter annotates all nodes and edges without changing order or the input", () => {
    const filtered = filterGraphSummaryByBuild(summary, buildA);
    expect(filtered.appId).toBe(summary.appId);
    expect(filtered.currentScreen).toBe(summary.currentScreen);
    expect(filtered.buildKey).toBe(buildA);
    expect(filtered.nodes.map(({ id, inFilterBuild }) => [id, inFilterBuild])).toEqual([
      [1, true],
      [2, true],
      [3, false],
      [4, false],
      [5, false],
    ]);
    expect(
      filtered.edges.map(({ id, inFilterBuild, unverifiedForFilterBuild }) => [
        id,
        inFilterBuild,
        unverifiedForFilterBuild,
      ]),
    ).toEqual([
      [1, true, false],
      [2, true, false],
      [3, false, true],
      [4, false, true],
      [5, false, false],
      [6, false, false],
    ]);
    expect(summary.nodes[0]).not.toHaveProperty("inFilterBuild");
    expect(summary.edges[0]).not.toHaveProperty("unverifiedForFilterBuild");
  });

  test("diff includes only observed nodes and edges with their build presence", () => {
    const diff = diffGraphSummaryByBuild(summary, buildA, buildB);
    expect(diff.appId).toBe(summary.appId);
    expect(diff.buildA).toBe(buildA);
    expect(diff.buildB).toBe(buildB);
    expect(diff.nodes.map(({ id, presence }) => [id, presence])).toEqual([
      [1, "both"],
      [2, "onlyA"],
      [3, "onlyB"],
    ]);
    expect(diff.edges.map(({ id, presence }) => [id, presence])).toEqual([
      [1, "both"],
      [2, "onlyA"],
      [3, "onlyB"],
    ]);
  });
});
