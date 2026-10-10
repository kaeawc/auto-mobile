import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { releaseSessionAndDevice } from "../../../src/daemon/releaseSessionAndDevice";
import type { SessionReleaseReason } from "../../../src/daemon/releaseReasons";
import { deviceLossCancellationReason } from "../../../src/utils/deviceLossCancellationReason";
import {
  BASE,
  LABEL_B,
  createPlanSessionHunt,
  deviceA,
  deviceB,
  deviceC,
  twoDevicePlan,
  type PlanSessionHunt,
} from "./planSessionHuntHarness";

// Hunt 2026-10-10 (plan sessions). A multi-device plan runs label B on the derived session
// `<base>:B`, a name the caller never chose and cannot replace. When label B's device is lost or
// killed while the plan runs, the daemon releases `<base>:B` with a TERMINAL reason
// (`device-disconnected:<id>` from the disconnect monitor, `device-killed` from killDevice), which
// fences that UUID for the daemon's lifetime (`terminalReleaseSnapshots` has no expiry, and the
// row is persisted terminal). The plan ends, the base is auto-released (`plan-auto-release`,
// re-issuable by name), and the caller runs the plan again under the same base, as clients that
// chain plans under one UUID do. The base is re-issued, but the allocator's mint of `<base>:B` is
// refused by the fence: every later multi-device plan under this base fails with an untyped
// `TerminalSessionError` that tells the caller to "acquire a new device" for a session it never
// held, although free devices can serve label B.
//
// Owner contracts: plan session UUIDs are re-issuable by name (a plan run again under the same
// name gets a working session); derived `<base>:<label>` sessions live only while the plan runs.

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

      // FAILS: success is false with
      // "TerminalSessionError: Session <base>:B is terminal after <reason> and cannot be reused.
      //  Acquire a new device with getAndroid or getApple." and no typed code.
      expect(rerun.error).toBeUndefined();
      expect(rerun.success).toBe(true);
      expect(Object.keys(rerun.deviceMapping ?? {})).toEqual(["A", "B"]);
    },
  );
});
