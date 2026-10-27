import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TIER1_CI_CONTEXT_ENV,
  TIER1_CONSUMED_ENV,
  TIER1_INPUT_HASH_ALGORITHM,
  TIER1_PLATFORM_INDEPENDENT_TASKS,
  expectedInputHashAlgorithm,
  tier1InputHash,
  type Tier1Inputs,
} from "../../../scripts/ci/attestation/tier1InputHash";
import {
  LaneInputHasher,
  type TreeProbe,
} from "../../../scripts/ci/attestation/produceAttestations";
import type { InputEntry } from "../../../scripts/ci/attestation/inputCanonical";
import { describeHashBoundary } from "./hashHarness";

const base = (): Tier1Inputs => ({
  entries: [
    { path: "src/a.ts", id: "aaa", mode: "100644" },
    { path: "src/b.ts", id: "bbb", mode: "100644" },
    { path: "bun.lock", id: "lll", mode: "100644" },
    { path: "turbo.json", id: "ttt", mode: "100644" },
  ],
  host: { os: "linux", arch: "x64", bunVersion: "1.4.4" },
  env: { AUTOMOBILE_TEST_MODE: "unit", PATH: "/usr/bin", HOME: "/home/a" },
});

describeHashBoundary<Tier1Inputs>("tier 1", {
  base,
  hash: (inputs) => tier1InputHash(inputs),
  mutations: {
    "a source file": (i) => ({
      ...i,
      entries: i.entries.map((e) => (e.path === "src/a.ts" ? { ...e, id: "changed" } : e)),
    }),
    "the lockfile": (i) => ({
      ...i,
      entries: i.entries.map((e) => (e.path === "bun.lock" ? { ...e, id: "bumped" } : e)),
    }),
    "turbo.json": (i) => ({
      ...i,
      entries: i.entries.map((e) => (e.path === "turbo.json" ? { ...e, id: "edited" } : e)),
    }),
    "a file added": (i) => ({
      ...i,
      entries: [...i.entries, { path: "src/c.ts", id: "ccc", mode: "100644" }],
    }),
    "a Bun version bump": (i) => ({ ...i, host: { ...i.host, bunVersion: "1.4.5" } }),
    "Bun missing": (i) => ({ ...i, host: { ...i.host, bunVersion: null } }),
    "the OS": (i) => ({ ...i, host: { ...i.host, os: "darwin" } }),
    "the CPU architecture": (i) => ({ ...i, host: { ...i.host, arch: "arm64" } }),
    "a consumed variable flipped": (i) => ({
      ...i,
      env: { ...i.env, AUTOMOBILE_TEST_MODE: "stress" },
    }),
    "a consumed variable set": (i) => ({
      ...i,
      env: { ...i.env, AUTOMOBILE_UNIT_TEST_WORKERS: "2" },
    }),
    "a consumed variable emptied": (i) => ({ ...i, env: { ...i.env, AUTOMOBILE_TEST_MODE: "" } }),
    "a consumed variable unset": (i) => ({
      ...i,
      env: { ...i.env, AUTOMOBILE_TEST_MODE: undefined },
    }),
  },
  perturbations: {
    "entries in another order": (i) => ({ ...i, entries: [...i.entries].reverse() }),
    "another checkout path (backslash, ./)": (i) => ({
      ...i,
      entries: i.entries.map((e) => ({ ...e, path: `./${e.path.replaceAll("/", "\\")}` })),
    }),
    "variables no task reads": (i) => ({
      ...i,
      env: { ...i.env, PATH: "/elsewhere", HOME: "/home/b", EDITOR: "vim", TERM: "dumb" },
    }),
    "CI-context markers": (i) => ({
      ...i,
      env: { ...i.env, CI: "true", GITHUB_ACTIONS: "true", GITHUB_BASE_REF: "main" },
    }),
    "variable order in the environment": (i) => ({
      ...i,
      env: Object.fromEntries(Object.entries(i.env).reverse()),
    }),
  },
});

describe("the consumed-variable audit", () => {
  const turbo = JSON.parse(readFileSync(join(import.meta.dir, "../../../turbo.json"), "utf8")) as {
    globalEnv?: string[];
    globalPassThroughEnv?: string[];
    tasks: Record<string, { env?: string[]; passThroughEnv?: string[] }>;
  };
  const named = new Set<string>([
    ...(turbo.globalEnv ?? []),
    ...(turbo.globalPassThroughEnv ?? []),
    ...Object.values(turbo.tasks).flatMap((task) => [
      ...(task.env ?? []),
      ...(task.passThroughEnv ?? []),
    ]),
  ]);

  test("every variable turbo.json names is hashed or a documented CI-context marker", () => {
    const unaccounted = [...named].filter(
      (name) => !TIER1_CONSUMED_ENV.includes(name) && !TIER1_CI_CONTEXT_ENV.includes(name),
    );
    expect(unaccounted).toEqual([]);
  });

  test("the lists name nothing turbo.json no longer reads, and do not overlap", () => {
    const stale = [...TIER1_CONSUMED_ENV, ...TIER1_CI_CONTEXT_ENV].filter(
      (name) => !named.has(name),
    );
    expect(stale).toEqual([]);
    expect(TIER1_CONSUMED_ENV.filter((name) => TIER1_CI_CONTEXT_ENV.includes(name))).toEqual([]);
  });

  test("no task is claimed platform-independent without proof", () => {
    expect(TIER1_PLATFORM_INDEPENDENT_TASKS).toEqual([]);
  });
});

describe("LaneInputHasher", () => {
  const probe = (entries: InputEntry[]): TreeProbe => ({
    headId: async () => "head",
    dirtyPaths: async () => [],
    inputEntries: async () => entries,
  });
  const entries: InputEntry[] = [{ path: "src/a.ts", id: "aaa", mode: "100644" }];
  const host = { os: "linux", arch: "x64", bunVersion: "1.4.4" };

  test("the node lane carries the tier 1 algorithm and the others the tree-entries one", async () => {
    const hasher = new LaneInputHasher(host, {});
    expect((await hasher.hash("node", probe(entries))).algorithm).toBe(TIER1_INPUT_HASH_ALGORITHM);
    for (const lane of ["android", "ios"] as const) {
      const result = await hasher.hash(lane, probe(entries));
      expect(result.algorithm).toBe(expectedInputHashAlgorithm(lane));
      expect(result.algorithm).not.toBe(TIER1_INPUT_HASH_ALGORITHM);
    }
  });

  test("the producer's hash is the one the gate recomputes, and a different host differs", async () => {
    const produced = await new LaneInputHasher(host, {}).hash("node", probe(entries));
    const recomputed = await new LaneInputHasher({ ...host }, {}).hash("node", probe(entries));
    const elsewhere = await new LaneInputHasher({ ...host, os: "darwin", arch: "arm64" }, {}).hash(
      "node",
      probe(entries),
    );
    expect(recomputed.hash).toBe(produced.hash);
    expect(elsewhere.hash).not.toBe(produced.hash);
  });

  test("a lane with no inputs is refused", async () => {
    await expect(new LaneInputHasher(host, {}).hash("node", probe([]))).rejects.toThrow("empty");
  });
});
