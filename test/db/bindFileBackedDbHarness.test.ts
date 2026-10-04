import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bindFileBackedDbHarness, type FileBackedDbHarness } from "./withFileBackedDb";

const env: NodeJS.ProcessEnv = { EXISTING: "registration-time" };
const created: string[] = [];
const removed: string[] = [];
let getHarness: () => FileBackedDbHarness;
let firstHarness: FileBackedDbHarness;
const unavailable = "File-backed DB harness is only available between beforeEach and afterEach";

// These cleanup assertions intentionally use Bun's sequential in-file test
// ordering. No concurrent tests: the following test observes the previous
// test's afterEach, and afterAll observes the last test's cleanup.
describe("bindFileBackedDbHarness", () => {
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
    // The snapshot must reflect beforeEach time, not binder registration time.
    env.EXISTING = "test-time";
  });

  test("returns the current harness and tracks temp dirs with injected fakes", async () => {
    firstHarness = getHarness();
    expect(getHarness()).toBe(firstHarness);
    env.EXISTING = "changed";
    env.ADDED = "new";
    const dir = await getHarness().makeTempDbDir("binder-first-");
    expect(created).toEqual([dir]);
    expect(removed).toEqual([]);
  });

  test("uses a fresh harness after restoring env and removing the previous temp dir", async () => {
    expect(getHarness()).not.toBe(firstHarness);
    expect(env).toEqual({ EXISTING: "test-time" });
    expect(removed).toEqual(created);
    delete env.EXISTING;
    env.ADDED = "second";
    await getHarness().makeTempDbDir("binder-second-");
  });

  afterAll(() => {
    expect(getHarness).toThrow(unavailable);
    expect(env).toEqual({ EXISTING: "test-time" });
    expect(created).toHaveLength(2);
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
