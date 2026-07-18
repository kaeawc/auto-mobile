import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { FileVouchStore } from "../../../src/features/vouch/FileVouchStore";
import { VouchEngine } from "../../../src/features/vouch/VouchEngine";
import { emptyVouchState } from "../../../src/features/vouch/types";
import { FakeTimer } from "../../fakes/FakeTimer";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";

describe("FileVouchStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vouch-store-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("load() returns an empty graph when the file does not exist", async () => {
    const store = new FileVouchStore(path.join(dir, "nested", "graph.json"));
    const state = await store.load();
    expect(state.members.size).toBe(0);
  });

  test("save() then load() round-trips and creates the parent directory", async () => {
    const store = new FileVouchStore(path.join(dir, "nested", "graph.json"));
    const engine = new VouchEngine({ timer: new FakeTimer(), idGenerator: new CountingIdGenerator("tok") });
    const state = emptyVouchState();
    engine.seedMember(state, "owner", "founder");

    await store.save(state);
    const reloaded = await store.load();
    expect(reloaded.members.get("owner")!.role).toBe("founder");
  });
});
