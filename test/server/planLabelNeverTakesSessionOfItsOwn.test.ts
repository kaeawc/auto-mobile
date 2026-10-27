import { beforeAll, describe, expect, test } from "bun:test";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import { PLAN_LABEL_SESSION_SOURCE, TerminalSessionError } from "../../src/daemon/sessionManager";
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

// #11602: a derived `<base>:<label>` session is minted by its base's plan run and by nothing else,
// and a plan run takes as a label only a session a plan run minted. Driven through the real
// executePlan tool, session manager and device pool.

/** One daemon per scenario, built and torn down by the scenario itself. */
const scenario = (body: (hunt: PlanSessionHunt) => Promise<void>) => async (): Promise<void> => {
  const hunt = await createPlanSessionHunt([deviceA, deviceB, deviceC]);
  try {
    await body(hunt);
  } finally {
    hunt.tearDown();
  }
};

const heldDevices = (hunt: PlanSessionHunt): string[] =>
  [deviceA, deviceB, deviceC]
    .filter((device) => hunt.poolHolder(device.deviceId) !== undefined)
    .map((device) => device.deviceId);

describe("who creates a session named like a label of a live base", () => {
  // The first executePlan pays the plan pipeline's one-time module and schema cost.
  beforeAll(async () => {
    const hunt = await createPlanSessionHunt([deviceA, deviceB, deviceC]);
    try {
      await hunt.acquire(BASE);
      await hunt.runPlan(twoDevicePlan(["B"]));
    } finally {
      hunt.tearDown();
    }
  });

  test(
    "a session id chosen before its prefix became a base stays a session of its own",
    scenario(async (hunt) => {
      const { sessionManager } = hunt.daemon();
      const ownDevice = await hunt.acquire(LABEL_B);
      const baseDevice = await hunt.acquire(BASE);

      expect(hunt.poolHolder(ownDevice)).toBe(LABEL_B);
      expect(hunt.poolHolder(baseDevice)).toBe(BASE);
      expect(sessionManager.ownershipSessionUuid(LABEL_B)).toBe(LABEL_B);
      expect(sessionManager.isLiveSessionOfSamePlan(LABEL_B, BASE)).toBe(false);
    }),
  );

  test(
    "a plan whose label names that session is refused typed and takes nothing from it",
    scenario(async (hunt) => {
      const { sessionManager } = hunt.daemon();
      const ownDevice = await hunt.acquire(LABEL_B);
      await hunt.acquire(BASE);
      const ran: string[] = [];
      hunt.setProbeStep(async (device) => {
        ran.push(device.deviceId);
      });

      const result = await hunt.runPlan(twoDevicePlan(["B"]));

      expect(result.success).toBe(false);
      expect(result.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(result.error).toContain(`device label 'B' would be session ${LABEL_B}`);
      expect(ran).toEqual([]);
      // The session is still its own: on its device, published by nobody, released with nobody.
      expect(hunt.poolHolder(ownDevice)).toBe(LABEL_B);
      expect(sessionManager.peekSession(LABEL_B)?.persistenceMetadata?.source).not.toBe(
        PLAN_LABEL_SESSION_SOURCE,
      );
      expect(sessionManager.getBaseSessionOfDerivedLabel(LABEL_B)).toBeUndefined();
      expect(sessionManager.ownershipSessionUuid(LABEL_B)).toBe(LABEL_B);
    }),
  );

  test(
    "a call naming an unallocated label of a live base creates nothing and holds no device",
    scenario(async (hunt) => {
      const { sessionManager, pool } = hunt.daemon();
      await hunt.acquire(BASE);
      const held = heldDevices(hunt);

      for (const stray of [LABEL_B, `${BASE}:Z`]) {
        await expect(sessionManager.getOrCreateSession(stray, pool, "ios")).rejects.toBeInstanceOf(
          TerminalSessionError,
        );
        expect(sessionManager.hasSession(stray)).toBe(false);
      }
      expect(heldDevices(hunt)).toEqual(held);

      // No fence was raised: the base's plan still mints the label.
      const result = await hunt.runPlan(twoDevicePlan(["B"]));
      expect(result.success).toBe(true);
    }),
  );

  test(
    "a plan run mints its label, marked as the plan's, while the base is live",
    scenario(async (hunt) => {
      const { sessionManager } = hunt.daemon();
      await hunt.acquire(BASE);
      let source: string | undefined;
      hunt.setProbeStep(async () => {
        source = sessionManager.peekSession(LABEL_B)?.persistenceMetadata?.source ?? undefined;
      });

      const result = await hunt.runPlan(twoDevicePlan(["B"]));

      expect(result.success).toBe(true);
      expect(source).toBe(PLAN_LABEL_SESSION_SOURCE);
    }),
  );
});
