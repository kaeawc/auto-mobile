import { describe, expect, test } from "bun:test";
import { runWithAcquisitionReceipt } from "../../src/daemon/acquisitionReceipt";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { DeviceSessionRecord } from "../../src/db/deviceSessionRepository";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// #11593: a request cancelled while the session it names is being minted must leave the id its
// client chose free to be created again. A daemon-minted id is still retired for good: nobody
// ever learned it. The table aborts at every await of the mint/persist path.

const SESSION_ID = "client-chosen-session";
const DEVICE_ID = "emulator-5554";

type PersistStep = "terminal-row read" | "active-row upsert" | "liveness ownership write";
const PERSIST_STEPS: PersistStep[] = [
  "terminal-row read",
  "active-row upsert",
  "liveness ownership write",
];

/** The in-memory repository, parking one chosen step until the test lets it finish. */
class SteppedPersistence extends FakeDeviceSessionPersistence {
  private parked: { step: PersistStep; reached: () => void; finish: Promise<void> } | undefined;
  private finishParked: (() => void) | undefined;

  override async getSession(sessionUuid: string) {
    await this.pass("terminal-row read");
    return await super.getSession(sessionUuid);
  }

  /** Park the next `step`; resolves once the mint is waiting on it. */
  park(step: PersistStep): Promise<void> {
    const reached = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    this.parked = { step, reached: reached.resolve, finish: finish.promise };
    this.finishParked = finish.resolve;
    return reached.promise;
  }

  finish(): void {
    this.finishParked?.();
  }

  private async pass(step: PersistStep): Promise<void> {
    const parked = this.parked;
    if (parked?.step !== step) {
      return;
    }
    this.parked = undefined;
    parked.reached();
    await parked.finish;
  }

  override async upsertActiveSession(
    ...args: Parameters<FakeDeviceSessionPersistence["upsertActiveSession"]>
  ): Promise<number> {
    const [record] = args as [DeviceSessionRecord];
    // The row is written first: a cancel that lands while the write is in flight finds it there.
    const generation = await super.upsertActiveSession(...args);
    if (record.sessionUuid === SESSION_ID) {
      await this.pass("active-row upsert");
    }
    return generation;
  }

  override async replaceLivenessOwnership(
    sessionUuid: string,
    ownerToken: string | null,
  ): Promise<void> {
    await super.replaceLivenessOwnership(sessionUuid, ownerToken);
    await this.pass("liveness ownership write");
  }

  async row(sessionUuid: string) {
    return await this.getSession(sessionUuid);
  }
}

/** Mint `SESSION_ID` and cancel the request while `step` is in flight. */
async function mintCancelledDuring(
  step: PersistStep,
  clientChosen: boolean,
): Promise<{ manager: SessionManager; persistence: SteppedPersistence; failure: unknown }> {
  const persistence = new SteppedPersistence();
  const manager = new SessionManager(new FakeTimer(), persistence);
  const controller = new AbortController();
  const reached = persistence.park(step);
  const minting = runWithAbortSignal(controller.signal, () =>
    runWithAcquisitionReceipt(clientChosen ? { clientChosenSessionId: SESSION_ID } : {}, () =>
      manager.createSession(SESSION_ID, DEVICE_ID, "android"),
    ),
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  await reached;
  controller.abort(new Error("client cancelled"));
  persistence.finish();
  return { manager, persistence, failure: await minting };
}

describe("a mint cancelled while its session is persisted", () => {
  test.each(PERSIST_STEPS)(
    "during the %s: a client-chosen id is not retired and its retry is created",
    async (step) => {
      const { manager, persistence, failure } = await mintCancelledDuring(step, true);
      try {
        expect(String(failure)).toContain("client cancelled");
        expect(manager.getSession(SESSION_ID)).toBeNull();
        expect(manager.getSessionForDevice(DEVICE_ID)).toBeNull();
        expect(manager.getTerminalReleaseSnapshot(SESSION_ID)).toBeUndefined();
        // No active row is left for a restart to rehydrate as a session nobody holds.
        expect((await persistence.row(SESSION_ID))?.status ?? "released").not.toBe("active");

        const retried = await manager.createSession(SESSION_ID, DEVICE_ID, "android");

        expect(retried.assignedDevice).toBe(DEVICE_ID);
        expect(manager.getSession(SESSION_ID)).toBe(retried);
        expect(await persistence.row(SESSION_ID)).toMatchObject({
          status: "active",
          release_reason: null,
        });
      } finally {
        manager.stopCleanupTimer();
      }
    },
  );

  test.each(PERSIST_STEPS)(
    "during the %s: an id the daemon minted is still retired for good",
    async (step) => {
      const { manager, failure } = await mintCancelledDuring(step, false);
      try {
        expect(String(failure)).toContain("client cancelled");
        expect(manager.getSession(SESSION_ID)).toBeNull();
        expect(manager.getTerminalReleaseSnapshot(SESSION_ID)).toMatchObject({
          releaseReason: "session-creation-cancelled",
          terminal: true,
        });
        await expect(manager.createSession(SESSION_ID, DEVICE_ID, "android")).rejects.toThrow();
      } finally {
        manager.stopCleanupTimer();
      }
    },
  );

  test("a receipt that names another id does not spare this one", async () => {
    const persistence = new SteppedPersistence();
    const manager = new SessionManager(new FakeTimer(), persistence);
    const controller = new AbortController();
    try {
      const reached = persistence.park("active-row upsert");
      const minting = runWithAbortSignal(controller.signal, () =>
        runWithAcquisitionReceipt({ clientChosenSessionId: "some-other-session" }, () =>
          manager.createSession(SESSION_ID, DEVICE_ID, "android"),
        ),
      ).catch((error: unknown) => error);
      await reached;
      controller.abort(new Error("client cancelled"));
      persistence.finish();
      await minting;

      expect(manager.getTerminalReleaseSnapshot(SESSION_ID)).toMatchObject({ terminal: true });
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("daemon shutdown still retires a client-chosen id caught mid-mint", async () => {
    const persistence = new SteppedPersistence();
    const manager = new SessionManager(new FakeTimer(), persistence);
    try {
      const reached = persistence.park("active-row upsert");
      const minting = runWithAcquisitionReceipt({ clientChosenSessionId: SESSION_ID }, () =>
        manager.createSession(SESSION_ID, DEVICE_ID, "android"),
      ).catch((error: unknown) => error);
      await reached;
      manager.stopAcceptingSessionCreations();
      persistence.finish();
      await minting;

      expect(manager.getTerminalReleaseSnapshot(SESSION_ID)).toMatchObject({
        releaseReason: "daemon-shutdown",
        terminal: true,
      });
    } finally {
      manager.stopCleanupTimer();
    }
  });
});
