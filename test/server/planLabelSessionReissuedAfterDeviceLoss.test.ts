import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import type { SessionReleaseReason } from "../../src/daemon/releaseReasons";
import { TerminalSessionError } from "../../src/daemon/sessionManager";
import { deviceRestartReleaseReason } from "../../src/db/deviceSessionRepository";
import { deviceLossCancellationReason } from "../../src/utils/deviceLossCancellationReason";
import {
  BASE,
  LABEL_B,
  createPlanSessionHunt,
  deviceA,
  deviceB,
  deviceC,
  twoDevicePlan,
  type PlanSessionHunt,
} from "../helpers/planSessionHarness";

// A multi-device plan runs label B on the derived session `<base>:B`, a name the caller never
// chose and cannot replace. A derived label session lives only as long as its plan run (#11572):
// however it ended (its device lost or killed mid-plan, which is a terminal release, or the plan's
// own `plan-auto-release`), the next plan run under the same base mints the label again, and
// nothing else does. A call that merely names the label session once it is over is refused as
// terminal and takes no device.

describe("a plan re-run after a label device was lost mid-plan", () => {
  let hunt: PlanSessionHunt;

  const setUp = async (): Promise<void> => {
    hunt = await createPlanSessionHunt([deviceA, deviceB, deviceC]);
    await hunt.acquire();
  };

  // The first executePlan pays the plan pipeline's one-time module and schema cost.
  beforeAll(async () => {
    await setUp();
    try {
      await hunt.runPlan(twoDevicePlan(["B"]));
    } finally {
      hunt.tearDown();
    }
  });
  beforeEach(setUp);
  afterEach(() => hunt.tearDown());

  const cases: Array<[string, SessionReleaseReason]> = [
    // daemon.ts disconnect monitor: cancelAndReleaseSession(session, deviceLossCancellationReason(id))
    ["its device disconnected", deviceLossCancellationReason(deviceB.deviceId)],
    // deviceToolsShutdown.ts releaseShutdownSessionOwnership: releaseSessionIfOwned(..., "device-killed")
    ["killDevice stopped its device", "device-killed"],
  ];

  test.each(cases)(
    "label B's session ended because %s: the next run under the same base gets a working label B",
    async (_why, reason) => {
      // Run 1: while the plan's step is on label B, its device goes away. The daemon ends the
      // session that holds the device and returns the device to the pool.
      hunt.setProbeStep(async (device) => {
        const { sessionManager, pool } = hunt.daemon();
        expect(sessionManager.getSession(LABEL_B)?.assignedDevice).toBe(device.deviceId);
        await releaseSessionAndDevice(sessionManager, pool, device.deviceId, LABEL_B, reason);
      });
      await hunt.runPlan(twoDevicePlan(["B"]));
      hunt.setProbeStep(async () => undefined);

      // The plan is over: nothing of it is left holding a device.
      const { sessionManager } = hunt.daemon();
      expect(sessionManager.getSession(BASE)).toBeNull();
      expect(sessionManager.getSession(LABEL_B)).toBeNull();
      expect([deviceA, deviceB, deviceC].map((d) => hunt.poolHolder(d.deviceId))).toEqual([
        undefined,
        undefined,
        undefined,
      ]);

      // Run 2: the same plan under the same base. Three devices are free.
      const rerun = await hunt.runPlan(twoDevicePlan(["B"]));

      expect(rerun.error).toBeUndefined();
      expect(rerun.success).toBe(true);
      expect(Object.keys(rerun.deviceMapping ?? {})).toEqual(["A", "B"]);
    },
  );

  test.each(cases)(
    "label B's session ended because %s: a call naming it is refused, during the plan and after it",
    async (_why, reason) => {
      let lateCallOfTheRun: Promise<unknown> | undefined;
      hunt.setProbeStep(async (device) => {
        const { sessionManager, pool } = hunt.daemon();
        await releaseSessionAndDevice(sessionManager, pool, device.deviceId, LABEL_B, reason);
        // The same run's next call on label B: its session ended, and is not minted again.
        lateCallOfTheRun = sessionManager.getOrCreateSession(LABEL_B, pool, "ios");
        await lateCallOfTheRun.catch(() => undefined);
      });
      await hunt.runPlan(twoDevicePlan(["B"]));
      hunt.setProbeStep(async () => undefined);
      await expect(lateCallOfTheRun).rejects.toBeInstanceOf(TerminalSessionError);

      const { sessionManager, pool } = hunt.daemon();
      // A stray client, or a call the old run sent late, naming the label session by its UUID.
      await expect(sessionManager.getOrCreateSession(LABEL_B, pool, "ios")).rejects.toBeInstanceOf(
        TerminalSessionError,
      );
      await expect(
        sessionManager.getOrCreateSession(LABEL_B, pool, "ios", undefined, true),
      ).rejects.toBeInstanceOf(TerminalSessionError);
      expect(sessionManager.getSession(LABEL_B)).toBeNull();
      expect(hunt.poolHolder(deviceB.deviceId)).toBeUndefined();
    },
  );

  test("a label session the plan released itself is not re-issued to a call that names it", async () => {
    const run = await hunt.runPlan(twoDevicePlan(["B"]));
    expect(run.success).toBe(true);
    const row = await hunt.persistence.getSession(LABEL_B);
    expect([row?.source, row?.release_reason]).toEqual(["plan-label", "plan-auto-release"]);

    const { sessionManager, pool } = hunt.daemon();
    // The row is re-issuable by name for a base session; for a label session only a plan run mints.
    const refused = sessionManager.getOrCreateSession(LABEL_B, pool, "ios", undefined, true);
    await expect(refused).rejects.toBeInstanceOf(TerminalSessionError);
    await expect(refused).rejects.toThrow("is terminal after plan-auto-release");
    await expect(sessionManager.getOrCreateSession(LABEL_B, pool, "ios")).rejects.toBeInstanceOf(
      TerminalSessionError,
    );
    expect([deviceA, deviceB, deviceC].map((d) => hunt.poolHolder(d.deviceId))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);

    // The refusals raised no fence: the next run under the same base still gets its label.
    const rerun = await hunt.runPlan(twoDevicePlan(["B"]));
    expect(rerun.error).toBeUndefined();
    expect(rerun.success).toBe(true);
  });

  test("a label session whose device restarts mid-plan is recovered by name, until the plan ends", async () => {
    let recovered: string | undefined;
    hunt.setProbeStep(async (device) => {
      const { sessionManager, pool } = hunt.daemon();
      const reason = deviceRestartReleaseReason(device.deviceId);
      await releaseSessionAndDevice(sessionManager, pool, device.deviceId, LABEL_B, reason);
      // The plan's next call on label B, with the device back: the same session, as for any
      // session waiting out a device restart.
      recovered = (await sessionManager.getOrCreateSession(LABEL_B, pool, "ios", undefined, true))
        .assignedDevice;
      expect(recovered).toBe(device.deviceId);
      // The device restarts again, and the plan ends before any call brings the session back.
      await releaseSessionAndDevice(sessionManager, pool, device.deviceId, LABEL_B, reason);
    });
    await hunt.runPlan(twoDevicePlan(["B"]));
    hunt.setProbeStep(async () => undefined);
    expect(recovered).toBeDefined();

    const { sessionManager, pool } = hunt.daemon();
    expect((await hunt.persistence.getSession(LABEL_B))?.release_reason).toBe(
      deviceRestartReleaseReason(recovered ?? ""),
    );
    // The plan is over: the handoff row is no longer recovered by name.
    await expect(
      sessionManager.getOrCreateSession(LABEL_B, pool, "ios", undefined, true),
    ).rejects.toBeInstanceOf(TerminalSessionError);
    expect(hunt.poolHolder(recovered ?? "")).toBeUndefined();
  });

  test("a label mint is open only for the allocation of the plan run that asked for it", async () => {
    const { sessionManager, pool } = hunt.daemon();
    hunt.setProbeStep(async (device) => {
      await releaseSessionAndDevice(
        sessionManager,
        pool,
        device.deviceId,
        LABEL_B,
        "device-killed",
      );
    });
    await hunt.runPlan(twoDevicePlan(["B"]));
    hunt.setProbeStep(async () => undefined);

    // With no plan run allocating, the pool's own mint of the name is refused by the fence.
    await expect(pool.assignMultipleDevices([LABEL_B], 1_000, "ios")).rejects.toBeInstanceOf(
      TerminalSessionError,
    );
    // An open mint names exactly this base's labels; closing it twice ends it once.
    const close = sessionManager.openPlanLabelMints(BASE, { A: BASE, B: LABEL_B });
    const closeOverlapping = sessionManager.openPlanLabelMints(BASE, { A: BASE, B: LABEL_B });
    close();
    close();
    const assigned = await pool.assignMultipleDevices([LABEL_B], 1_000, "ios");
    expect(assigned.get(LABEL_B)).toBeDefined();
    closeOverlapping();
    await releaseSessionAndDevice(
      sessionManager,
      pool,
      assigned.get(LABEL_B) ?? null,
      LABEL_B,
      "device-killed",
    );
    await expect(pool.assignMultipleDevices([LABEL_B], 1_000, "ios")).rejects.toBeInstanceOf(
      TerminalSessionError,
    );
  });
});
