import { describe, expect, test } from "bun:test";
import {
  HostBootAdmissionRegistryError,
  type HostBootAdmissionRegistry,
} from "../../src/features/bootAdmission/HostBootAdmissionRegistry";
import type { FakeTimer } from "../fakes/FakeTimer";

export interface HostBootAdmissionRegistryHandle {
  /** One daemon process's registry on the shared host. Opening a pid marks it running. */
  open(pid: number): HostBootAdmissionRegistry;
  /** Process liveness as the host sees it (an owner daemon or a handed-off emulator). */
  setRunning(pid: number, running: boolean): void;
  timer: FakeTimer;
  dispose?: () => Promise<void> | void;
}

const OWNER = 100;
const PEER = 200;
const EMULATOR_PID = 4242;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

async function settle(promise: Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

/** Steps fake time in poll-sized increments until the promise settles. */
async function advanceUntilSettled(
  timer: FakeTimer,
  promise: Promise<unknown>,
): Promise<{ value?: unknown; error?: unknown }> {
  let settled = false;
  const outcome = settle(promise).finally(() => {
    settled = true;
  });
  for (let step = 0; step < 20 && !settled; step++) {
    await flushMicrotasks();
    if (!settled) {
      timer.advanceTime(25);
    }
  }
  return outcome;
}

/**
 * Shared behavioural contract for {@link HostBootAdmissionRegistry} (#11868): the in-memory fake
 * the boot-gate tests share between simulated daemons, and the file-backed registry over a
 * private temp directory, run the same publish/update/expiry/lock scenarios. Only behaviour the
 * gate relies on is pinned; record order and generation tokens are implementation detail.
 */
export function runHostBootAdmissionRegistryContract(
  name: string,
  make: () => Promise<HostBootAdmissionRegistryHandle>,
): void {
  const withHost = async (
    body: (handle: HostBootAdmissionRegistryHandle) => Promise<void> | void,
  ): Promise<void> => {
    const handle = await make();
    try {
      await body(handle);
    } finally {
      await handle.dispose?.();
    }
  };

  describe(`HostBootAdmissionRegistry contract: ${name}`, () => {
    test("a publication is visible to peers but never to its owner", () =>
      withHost((host) => {
        const owner = host.open(OWNER);
        const peer = host.open(PEER);
        owner.publish({ deviceId: "emulator-5554", admittedUntilMs: 60_000, replacement: true });
        expect(owner.readPeerAdmissions()).toEqual([]);
        const [record, ...rest] = peer.readPeerAdmissions();
        expect(rest).toEqual([]);
        expect(record).toMatchObject({
          ownerPid: OWNER,
          deviceId: "emulator-5554",
          admittedUntilMs: 60_000,
          replacement: true,
        });
        expect(typeof record.id).toBe("string");
        expect(record.id.length).toBeGreaterThan(0);
      }));

    test("a publication without fields records only its owner", () =>
      withHost((host) => {
        host.open(OWNER).publish();
        const [record] = host.open(PEER).readPeerAdmissions();
        expect(record.ownerPid).toBe(OWNER);
        expect(record.deviceId).toBeUndefined();
        expect(record.admittedUntilMs).toBeUndefined();
        expect(record.replacement).toBeUndefined();
      }));

    test("every publication on the host gets a distinct id", () =>
      withHost((host) => {
        const owner = host.open(OWNER);
        owner.publish({ deviceId: "emulator-5554" });
        owner.publish({ deviceId: "emulator-5556" });
        host.open(PEER).publish({ deviceId: "emulator-5558" });
        const records = host.open(300).readPeerAdmissions();
        expect(records.map((record) => record.deviceId).sort()).toEqual([
          "emulator-5554",
          "emulator-5556",
          "emulator-5558",
        ]);
        expect(new Set(records.map((record) => record.id)).size).toBe(3);
      }));

    test("update merges defined fields and leaves undefined ones untouched", () =>
      withHost((host) => {
        const published = host
          .open(OWNER)
          .publish({ deviceId: "emulator-5554", admittedUntilMs: 60_000 });
        published.update({
          deviceId: undefined,
          processId: EMULATOR_PID,
          handedOffUntilMs: 90_000,
        });
        expect(host.open(PEER).readPeerAdmissions()).toMatchObject([
          {
            ownerPid: OWNER,
            deviceId: "emulator-5554",
            admittedUntilMs: 60_000,
            processId: EMULATOR_PID,
            handedOffUntilMs: 90_000,
          },
        ]);
      }));

    test("clearDeviceId drops the serial and a later update can set a new one", () =>
      withHost((host) => {
        const peer = host.open(PEER);
        const published = host
          .open(OWNER)
          .publish({ deviceId: "emulator-5554", replacement: true });
        published.clearDeviceId();
        published.clearDeviceId();
        expect(peer.readPeerAdmissions()[0].deviceId).toBeUndefined();
        expect(peer.readPeerAdmissions()[0].replacement).toBe(true);
        published.update({ deviceId: "emulator-5556", replacement: false });
        expect(peer.readPeerAdmissions()).toMatchObject([
          { deviceId: "emulator-5556", replacement: false },
        ]);
      }));

    test("remove is idempotent, silences later writes and spares other publications", () =>
      withHost((host) => {
        const owner = host.open(OWNER);
        const peer = host.open(PEER);
        const removed = owner.publish({ deviceId: "emulator-5554" });
        owner.publish({ deviceId: "emulator-5556" });
        removed.remove();
        removed.remove();
        removed.update({ deviceId: "emulator-5560" });
        removed.clearDeviceId();
        expect(peer.readPeerAdmissions().map((record) => record.deviceId)).toEqual([
          "emulator-5556",
        ]);
      }));

    test("peer reads are snapshots, not live views of the shared records", () =>
      withHost((host) => {
        const peer = host.open(PEER);
        host.open(OWNER).publish({ deviceId: "emulator-5554" });
        const [snapshot] = peer.readPeerAdmissions();
        snapshot.deviceId = "mutated";
        expect(peer.readPeerAdmissions()[0].deviceId).toBe("emulator-5554");
      }));

    test("an admission whose boot budget elapsed is no longer visible", () =>
      withHost((host) => {
        const peer = host.open(PEER);
        host.open(OWNER).publish({ deviceId: "emulator-5554", admittedUntilMs: 1_000 });
        host.timer.advanceTime(999);
        expect(peer.readPeerAdmissions()).toHaveLength(1);
        host.timer.advanceTime(1);
        expect(peer.readPeerAdmissions()).toEqual([]);
      }));

    test("an admission whose owner process exited is no longer visible", () =>
      withHost((host) => {
        const peer = host.open(PEER);
        host.open(OWNER).publish({ deviceId: "emulator-5554", admittedUntilMs: 60_000 });
        host.setRunning(OWNER, false);
        expect(peer.readPeerAdmissions()).toEqual([]);
      }));

    test("a handed-off admission outlives its owner until its hand-off deadline", () =>
      withHost((host) => {
        const peer = host.open(PEER);
        host.setRunning(EMULATOR_PID, true);
        const published = host.open(OWNER).publish({ admittedUntilMs: 1_000 });
        published.update({ processId: EMULATOR_PID, handedOffUntilMs: 5_000 });
        host.setRunning(OWNER, false);
        host.timer.advanceTime(2_000);
        expect(peer.readPeerAdmissions()).toMatchObject([
          { ownerPid: OWNER, processId: EMULATOR_PID },
        ]);
        host.timer.advanceTime(3_000);
        expect(peer.readPeerAdmissions()).toEqual([]);
      }));

    test("a handed-off admission is dropped once its owner and process both exited", () =>
      withHost((host) => {
        const peer = host.open(PEER);
        host.setRunning(EMULATOR_PID, true);
        const published = host.open(OWNER).publish({ admittedUntilMs: 60_000 });
        published.update({ processId: EMULATOR_PID, handedOffUntilMs: 90_000 });
        host.setRunning(EMULATOR_PID, false);
        expect(peer.readPeerAdmissions()).toHaveLength(1);
        host.setRunning(OWNER, false);
        expect(peer.readPeerAdmissions()).toEqual([]);
      }));

    test("withAdmissionLock returns the callback's result and releases the lock", () =>
      withHost(async (host) => {
        const owner = host.open(OWNER);
        expect(await owner.withAdmissionLock({ timeoutMs: 100 }, async () => 7)).toBe(7);
        expect(await host.open(PEER).withAdmissionLock({ timeoutMs: 100 }, async () => 8)).toBe(8);
      }));

    test("a throwing callback propagates its error and releases the lock", () =>
      withHost(async (host) => {
        const boom = new Error("boom");
        const outcome = await settle(
          host.open(OWNER).withAdmissionLock({ timeoutMs: 100 }, async () => {
            throw boom;
          }),
        );
        expect(outcome.error).toBe(boom);
        expect(await host.open(PEER).withAdmissionLock({ timeoutMs: 100 }, async () => 8)).toBe(8);
      }));

    for (const sameProcess of [false, true]) {
      test(`a held lock excludes ${sameProcess ? "a second caller in the same process" : "a peer process"} until released`, () =>
        withHost(async (host) => {
          const first = host.open(OWNER);
          const second = sameProcess ? first : host.open(PEER);
          const held = deferred();
          const entered: string[] = [];
          const holder = first.withAdmissionLock({ timeoutMs: 100 }, async () => {
            entered.push("holder");
            await held.promise;
          });
          await flushMicrotasks();
          expect(entered).toEqual(["holder"]);
          const waiter = second.withAdmissionLock({ timeoutMs: 100 }, async () => {
            entered.push("waiter");
          });
          await flushMicrotasks();
          expect(entered).toEqual(["holder"]);
          held.resolve();
          await holder;
          expect((await advanceUntilSettled(host.timer, waiter)).error).toBeUndefined();
          expect(entered).toEqual(["holder", "waiter"]);
        }));
    }

    test("a lock held past the timeout rejects the waiter without running its callback", () =>
      withHost(async (host) => {
        const held = deferred();
        const holder = host
          .open(OWNER)
          .withAdmissionLock({ timeoutMs: 100 }, async () => held.promise);
        await flushMicrotasks();
        let ran = false;
        const outcome = await advanceUntilSettled(
          host.timer,
          host.open(PEER).withAdmissionLock({ timeoutMs: 50 }, async () => {
            ran = true;
          }),
        );
        expect(outcome.error).toBeInstanceOf(HostBootAdmissionRegistryError);
        expect((outcome.error as HostBootAdmissionRegistryError).code).toBe("timeout");
        expect(ran).toBe(false);
        held.resolve();
        await holder;
      }));

    test("an already-aborted signal rejects with its reason before running the callback", () =>
      withHost(async (host) => {
        const controller = new AbortController();
        controller.abort();
        let ran = false;
        const outcome = await settle(
          host
            .open(OWNER)
            .withAdmissionLock({ timeoutMs: 100, signal: controller.signal }, async () => {
              ran = true;
            }),
        );
        expect(outcome.error).toBe(controller.signal.reason);
        expect(ran).toBe(false);
        expect(await host.open(PEER).withAdmissionLock({ timeoutMs: 100 }, async () => 8)).toBe(8);
      }));

    test("aborting a waiting caller rejects it and leaves the holder's lock in place", () =>
      withHost(async (host) => {
        const held = deferred();
        const holder = host
          .open(OWNER)
          .withAdmissionLock({ timeoutMs: 100 }, async () => held.promise);
        await flushMicrotasks();
        const controller = new AbortController();
        let ran = false;
        const waiter = settle(
          host
            .open(PEER)
            .withAdmissionLock({ timeoutMs: 100, signal: controller.signal }, async () => {
              ran = true;
            }),
        );
        await flushMicrotasks();
        controller.abort();
        expect((await waiter).error).toBe(controller.signal.reason);
        expect(ran).toBe(false);
        let thirdRan = false;
        const third = host.open(300).withAdmissionLock({ timeoutMs: 100 }, async () => {
          thirdRan = true;
        });
        await flushMicrotasks();
        expect(thirdRan).toBe(false);
        held.resolve();
        await holder;
        expect((await advanceUntilSettled(host.timer, third)).error).toBeUndefined();
        expect(thirdRan).toBe(true);
      }));
  });
}
