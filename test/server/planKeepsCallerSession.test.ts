import { beforeAll, expect, test } from "bun:test";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import { TerminalSessionError } from "../../src/daemon/sessionManager";
import { deviceRestartReleaseReason } from "../../src/db/deviceSessionRepository";
import {
  BASE,
  LABEL_B,
  createPlanSessionHunt,
  deviceA,
  deviceB,
  twoDevicePlan,
} from "../helpers/planSessionHarness";

const singleDevicePlan = "name: caller-session\nsteps:\n  - tool: huntProbe\n    params: {}\n";

beforeAll(async () => {
  const hunt = await createPlanSessionHunt([deviceA]);
  try {
    await hunt.acquire();
    await hunt.runPlan(singleDevicePlan);
  } finally {
    hunt.tearDown();
  }
});

test("a retained base does not keep a finished label's restart handoff recoverable", async () => {
  const hunt = await createPlanSessionHunt([deviceA, deviceB]);
  try {
    const deviceId = await hunt.acquire();
    const { sessionManager, pool } = hunt.daemon();
    hunt.setProbeStep(async (device) => {
      await releaseSessionAndDevice(sessionManager, pool, device.deviceId, LABEL_B, {
        reason: deviceRestartReleaseReason(device.deviceId),
      });
    });

    await hunt.runPlan(twoDevicePlan(["B"]));

    expect(sessionManager.getSession(BASE)?.assignedDevice).toBe(deviceId);
    await expect(
      sessionManager.getOrCreateSession(LABEL_B, pool, "ios", { requireIssuedSession: true }),
    ).rejects.toBeInstanceOf(TerminalSessionError);
    expect(hunt.poolHolder(deviceB.deviceId)).toBeUndefined();
  } finally {
    hunt.tearDown();
  }
});

test.each(["completed", "failed", "cancelled"] as const)(
  "a %s plan preserves the caller's session and device",
  async (outcome) => {
    const hunt = await createPlanSessionHunt([deviceA]);
    try {
      const deviceId = await hunt.acquire();
      const controller = new AbortController();
      let probed = false;
      hunt.setProbeStep(async (_device, signal) => {
        probed = true;
        if (outcome === "failed") {
          throw new Error("probe failed");
        }
        if (outcome === "cancelled") {
          controller.abort(new Error("probe cancelled"));
          signal?.throwIfAborted();
        }
      });

      const result = await hunt.runPlan(singleDevicePlan, controller.signal);

      expect(probed).toBe(true);
      expect(result.success).toBe(outcome === "completed");
      expect(controller.signal.aborted).toBe(outcome === "cancelled");
      expect(hunt.daemon().sessionManager.getSession(BASE)?.assignedDevice).toBe(deviceId);
      expect(hunt.poolHolder(deviceId)).toBe(BASE);
    } finally {
      hunt.tearDown();
    }
  },
);

test("a plan releases a base session it acquired itself", async () => {
  const hunt = await createPlanSessionHunt([deviceA]);
  try {
    // Automation refuses never-issued UUIDs. A released base can be re-issued by the plan.
    const deviceId = await hunt.acquire();
    const { sessionManager, pool } = hunt.daemon();
    await releaseSessionAndDevice(sessionManager, pool, deviceId, BASE, {
      reason: "plan-auto-release",
    });
    expect(hunt.daemon().sessionManager.getSession(BASE)).toBeNull();
    hunt.setProbeStep(async (device) => {
      expect(hunt.poolHolder(device.deviceId)).toBe(BASE);
    });

    expect((await hunt.runPlan(singleDevicePlan)).success).toBe(true);

    expect(hunt.daemon().sessionManager.getSession(BASE)).toBeNull();
    expect(hunt.poolHolder(deviceA.deviceId)).toBeUndefined();
  } finally {
    hunt.tearDown();
  }
});

test("a plan releases its labels, clears their map, and preserves the base for the next run", async () => {
  const hunt = await createPlanSessionHunt([deviceA, deviceB]);
  try {
    const deviceId = await hunt.acquire();
    const { sessionManager } = hunt.daemon();
    const released: string[] = [];
    sessionManager.onSessionRelease((id) => {
      released.push(id);
    });
    hunt.setProbeStep(async () => {
      expect(sessionManager.getSession(LABEL_B)?.assignedDevice).toBe(deviceB.deviceId);
    });

    for (let run = 0; run < 2; run++) {
      expect((await hunt.runPlan(twoDevicePlan(["A", "B"]))).success).toBe(true);
      expect(sessionManager.getSession(BASE)?.assignedDevice).toBe(deviceId);
      expect(hunt.poolHolder(deviceId)).toBe(BASE);
      expect(sessionManager.getSession(LABEL_B)).toBeNull();
      expect(hunt.poolHolder(deviceB.deviceId)).toBeUndefined();
      expect(sessionManager.getDeviceLabels(BASE)).toBeUndefined();
    }
    expect(released).toEqual([LABEL_B, LABEL_B]);
    // A different label set also works on the retained base.
    hunt.setProbeStep(async () => undefined);
    expect((await hunt.runPlan(twoDevicePlan(["A"]).replace("  - B\n", "  - C\n"))).success).toBe(
      true,
    );
  } finally {
    hunt.tearDown();
  }
});

// A recovery hold preserves the original owner: only a plan-acquired base is plan-held.
test.each(["plan", "caller", "released-and-reacquired"] as const)(
  "recovery preserves original ownership (%s)",
  async (owner) => {
    const callerAcquired = owner === "caller";
    const hunt = await createPlanSessionHunt([deviceA]);
    try {
      const { sessionManager } = hunt.daemon();
      if (callerAcquired) {
        await hunt.acquire();
      } else {
        // Admission requires an issued UUID. Seed only its historical row: the plan, not
        // this caller, acquires the live session and device for this run.
        await hunt.persistence.upsertActiveSession({
          sessionUuid: BASE,
          deviceId: deviceA.deviceId,
          platform: "ios",
          createdAtMs: hunt.timer.now(),
          lastUsedAtMs: hunt.timer.now(),
          expiresAtMs: hunt.timer.now() + 60_000,
          sessionTimeoutMs: 60_000,
          heartbeatTimeoutMs: 60_000,
          hasReceivedHeartbeat: false,
        });
        await hunt.persistence.markReleased(BASE, "released", hunt.timer.now(), {
          reason: "plan-auto-release",
        });
      }
      hunt.setProbeStep(async () => {
        throw new Error("recoverable probe failure");
      });
      const failed = await hunt.runPlan(singleDevicePlan, undefined, {
        holdSessionOnFailure: true,
      });
      expect(failed.success).toBe(false);
      const uuid = callerAcquired ? BASE : hunt.poolHolder(deviceA.deviceId);
      expect(uuid).toBeDefined();
      expect(sessionManager.peekSession(uuid!)?.assignedDevice).toBe(deviceA.deviceId);
      expect(hunt.poolHolder(deviceA.deviceId)).toBe(uuid);
      if (owner === "released-and-reacquired") {
        // Any release must forget the plan hold before a caller re-acquires this UUID.
        await releaseSessionAndDevice(sessionManager, hunt.daemon().pool, deviceA.deviceId, uuid!, {
          reason: "plan-auto-release",
        });
        await hunt.acquire(uuid);
      }
      const callerOwnsAtResume = owner !== "plan";
      hunt.setProbeStep(async () => undefined);
      expect((await hunt.runPlan(singleDevicePlan, undefined, { sessionUuid: uuid })).success).toBe(
        true,
      );
      expect(sessionManager.hasSession(uuid!)).toBe(callerOwnsAtResume);
      expect(hunt.poolHolder(deviceA.deviceId)).toBe(callerOwnsAtResume ? uuid : undefined);
    } finally {
      hunt.tearDown();
    }
  },
);

test("a plan preserves a caller's session resumed within its device-restart window", async () => {
  const hunt = await createPlanSessionHunt([deviceA]);
  try {
    const deviceId = await hunt.acquire();
    const { sessionManager, pool } = hunt.daemon();
    await releaseSessionAndDevice(sessionManager, pool, deviceId, BASE, {
      reason: deviceRestartReleaseReason(deviceId),
    });
    expect(sessionManager.peekSession(BASE)).toBeNull();
    expect(await sessionManager.isReleasedSessionInRestartRecoveryWindow(BASE)).toBe(true);
    expect((await hunt.runPlan(singleDevicePlan)).success).toBe(true);
    expect(sessionManager.peekSession(BASE)?.assignedDevice).toBe(deviceId);
    expect(hunt.poolHolder(deviceId)).toBe(BASE);
  } finally {
    hunt.tearDown();
  }
});
