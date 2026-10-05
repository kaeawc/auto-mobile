import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { bindFileBackedDbHarness, type FileBackedDbHarness } from "./withFileBackedDb";

const env: NodeJS.ProcessEnv = { EXISTING: "registration-time" };
const created: string[] = [];
const removed: string[] = [];
let getHarness: () => FileBackedDbHarness;
const seenHarnesses = new Set<FileBackedDbHarness>();
const unavailable = "File-backed DB harness is only available between beforeEach and afterEach";

// Reset fake state before binding and assert cleanup after the binder's hook,
// so each test verifies its own lifecycle regardless of randomized order.
describe("bindFileBackedDbHarness", () => {
  beforeEach(() => {
    expect(getHarness).toThrow(unavailable);
    expect(removed).toEqual(created);
    created.length = 0;
    removed.length = 0;
    for (const key of Object.keys(env)) {
      delete env[key];
    }
    env.EXISTING = "test-time";
  });

  getHarness = bindFileBackedDbHarness({
    env,
    mkdtemp: async (prefix) => {
      const dir = `${prefix}${created.length}`;
      created.push(dir);
      return dir;
    },
    removeTempDir: async (dir) => {
      removed.push(dir);
    },
    importDatabaseModule: async () => {
      throw new Error("Binder unit tests must never open a DB");
    },
  });

  beforeAll(() => {
    expect(getHarness).toThrow(unavailable);
    expect(created).toEqual([]);
  });

  beforeEach(() => {
    const harness = getHarness();
    expect(seenHarnesses.has(harness)).toBe(false);
    seenHarnesses.add(harness);
    // The snapshot must reflect beforeEach time, not binder registration time.
    expect(env).toEqual({ EXISTING: "test-time" });
  });

  afterEach(() => {
    expect(getHarness).toThrow(unavailable);
    expect(env).toEqual({ EXISTING: "test-time" });
    expect(created).toHaveLength(1);
    expect(removed).toEqual(created);
  });

  test("returns the current harness and tracks temp dirs with injected fakes", async () => {
    const firstHarness = getHarness();
    expect(getHarness()).toBe(firstHarness);
    env.EXISTING = "changed";
    env.ADDED = "new";
    const dir = await getHarness().makeTempDbDir("binder-first-");
    expect(created).toEqual([dir]);
    expect(removed).toEqual([]);
  });

  test("restores deleted env keys and removes its own temp dir", async () => {
    expect(env).toEqual({ EXISTING: "test-time" });
    expect(removed).toEqual(created);
    delete env.EXISTING;
    env.ADDED = "second";
    const dir = await getHarness().makeTempDbDir("binder-second-");
    expect(created).toEqual([dir]);
    expect(removed).toEqual([]);
  });

  afterAll(() => {
    expect(getHarness).toThrow(unavailable);
    expect(env).toEqual({ EXISTING: "test-time" });
    expect(seenHarnesses.size).toBe(2);
    expect(created).toHaveLength(1);
    expect(removed).toEqual(created);
  });
});

describe("sibling describe without the binder", () => {
  test("does not inherit the bound describe's hooks", () => {
    // An incorrectly global beforeEach would make this getter available.
    expect(getHarness).toThrow(unavailable);
    expect(removed).toEqual(created);
    env.SIBLING = "retained";
  });

  afterAll(() => {
    // An incorrectly global afterEach would restore the binder's env snapshot.
    expect(env.SIBLING).toBe("retained");
    expect(getHarness).toThrow(unavailable);
    expect(removed).toEqual(created);
  });
});
