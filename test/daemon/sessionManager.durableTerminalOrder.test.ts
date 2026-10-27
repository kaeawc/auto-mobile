import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoopTerminalReleaseJournal } from "../../src/daemon/NoopTerminalReleaseJournal";
import {
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
  SessionManager,
} from "../../src/daemon/sessionManager";
import { FileTerminalReleaseJournal } from "../../src/daemon/terminalReleaseJournal";
import { fixedBackoff } from "../../src/utils/Backoff";
import { BusyRewritePersistence } from "../fakes/BusyRewritePersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeTerminalReleaseJournalFileSystem } from "../fakes/FakeTerminalReleaseJournalFileSystem";
import { FakeTimer } from "../fakes/FakeTimer";

const SESSION = "s1";
const DEVICE = "emulator-5554";
const LOSS = `device-disconnected:${DEVICE}`;
const JOURNAL = "/data/journal.jsonl";
const RETRY_MS = 700;

async function settle(turns = 100): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve();
  }
}

// #11799: a terminal release with a durable journal intent commits before its row is written;
// a volatile one still writes the row first. The ordering is what lets the final supersede fence
// stop being a reason to rewrite a terminal row.
describe("terminal release order by journal durability (#11799)", () => {
  let timer: FakeTimer;
  let store: BusyRewritePersistence;
  let manager: SessionManager;
  let files: FakeTerminalReleaseJournalFileSystem;
  let journal: FileTerminalReleaseJournal;
  let notices: string[];
  let releaseWrites = 0;
  const attempts = () => releaseWrites;
  const intents = () => journal.loadUnconfirmed().map((intent) => intent.reason);

  beforeEach(async () => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    store = new BusyRewritePersistence();
    releaseWrites = 0;
    const markReleased = store.markReleased.bind(store);
    store.markReleased = (...args) => {
      releaseWrites++;
      return markReleased(...args);
    };
    files = new FakeTerminalReleaseJournalFileSystem();
    journal = new FileTerminalReleaseJournal(JOURNAL, files);
    manager = new SessionManager(timer, store, { barrier: () => new FakeDbWriteBarrier() });
    manager.stopCleanupTimer();
    manager.setTerminalReleaseRetryBackoff(fixedBackoff(RETRY_MS));
    manager.attachTerminalReleaseJournal(journal);
    notices = [];
    manager.onSessionRelease((_id, _device, reason) => notices.push(reason));
    await manager.createSession(SESSION, DEVICE, "android", { timeoutMs: 60_000 });
  });

  afterEach(() => {
    manager.stopCleanupTimer();
  });

  test("a durable intent frees the device while the row statement is still parked", async () => {
    const land = Promise.withResolvers<void>();
    store.park = land.promise;
    const release = manager.releaseSession(SESSION, LOSS);
    await settle();

    expect(notices).toEqual([LOSS]);
    expect(manager.getSessionForDevice(DEVICE)).toBeNull();
    expect(intents()).toEqual([LOSS]);
    expect((await store.getSession(SESSION))?.status).toBe("active");

    store.park = undefined;
    land.resolve();
    await expect(release).resolves.toBe(DEVICE);
    expect(await store.getSession(SESSION)).toMatchObject({ release_reason: LOSS });
    expect(intents()).toEqual([]);
  });

  test("a volatile intent frees the device only after the row landed", async () => {
    manager.attachTerminalReleaseJournal(new NoopTerminalReleaseJournal());
    const land = Promise.withResolvers<void>();
    store.park = land.promise;
    const release = manager.releaseSession(SESSION, LOSS);
    await settle();

    expect(notices).toEqual([]);
    expect(manager.getSessionForDevice(DEVICE)).toBe(SESSION);

    store.park = undefined;
    land.resolve();
    await expect(release).resolves.toBe(DEVICE);
    expect(notices).toEqual([LOSS]);
    expect(await store.getSession(SESSION)).toMatchObject({ release_reason: LOSS });
  });

  test("a final fence that declines leaves no row, no fence and no journal intent", async () => {
    let evaluations = 0;
    const result = await manager.releaseSessionUnlessSuperseded(SESSION, LOSS, {
      commitFence: () => ++evaluations < 2,
    });

    expect(result).toEqual({ superseded: true });
    expect(evaluations).toBe(2);
    expect(attempts()).toBe(0);
    expect(manager.getSession(SESSION)).not.toBeNull();
    expect(manager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
    expect(intents()).toEqual([]);
    expect((await store.getSession(SESSION))?.status).toBe("active");
    expect(notices).toEqual([]);
  });

  test("the intent is recorded once, ahead of the row", async () => {
    const recorded: string[] = [];
    const record = journal.record.bind(journal);
    journal.record = (intent) => {
      recorded.push(`${intent.reason}:${attempts()}`);
      return record(intent);
    };
    await manager.releaseSession(SESSION, LOSS);
    expect(recorded).toEqual([`${LOSS}:0`]);
  });

  test("a failed row after the commit rejects the release, still frees the device and retries", async () => {
    store.failReleaseWrites = 1;
    await expect(manager.releaseSession(SESSION, LOSS)).rejects.toThrow();

    expect(notices).toEqual([LOSS]);
    expect(manager.getSessionForDevice(DEVICE)).toBeNull();
    expect(manager.getSession(SESSION)).toBeNull();
    expect(manager.getTerminalReleaseSnapshot(SESSION)).toMatchObject({ releaseReason: LOSS });
    expect(intents()).toEqual([LOSS]);

    await timer.advanceTimeAsync(RETRY_MS);
    await settle();
    expect(await store.getSession(SESSION)).toMatchObject({ release_reason: LOSS });
    expect(intents()).toEqual([]);
  });

  test("a row parked past the deadline still frees the device, and lands later", async () => {
    const land = Promise.withResolvers<void>();
    store.park = land.promise;
    const release = manager.releaseSession(SESSION, LOSS);
    await settle();
    await timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
    await expect(release).resolves.toBe(DEVICE);
    expect(notices).toEqual([LOSS]);
    expect((await store.getSession(SESSION))?.status).toBe("active");

    store.park = undefined;
    land.resolve();
    await settle();
    expect(await store.getSession(SESSION)).toMatchObject({ release_reason: LOSS });
    expect(intents()).toEqual([]);
  });
});
