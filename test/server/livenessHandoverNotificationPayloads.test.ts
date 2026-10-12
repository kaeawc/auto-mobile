import { expect, test } from "bun:test";
import {
  livenessHandoverNotificationPayloads,
  managedEndedPayload,
} from "../../src/server/proxyServer";
import {
  livenessHandoverPayload,
  type LivenessHandover,
} from "../../src/daemon/proxyLivenessRecovery";
import { readyManagedSlotsResult } from "../helpers/refusalWireFixtures";

// #11483 item 1: which logging notifications one liveness handover becomes. The end-to-end answer
// is covered in managedProxyStalledLossAnswer.test.ts; this pins the cases that harness cannot
// reach cheaply (a daemon stall, and a handover listing a session that is not a slot).

const SESSION = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

const handover: LivenessHandover = {
  code: "proxy_stalled",
  sessions: [{ sessionUuid: SESSION, deviceId: "emulator-5554", lastAcknowledgedHeartbeatAt: 0 }],
  attempts: 1,
  lastAcknowledgedHeartbeatAt: 0,
  action: "reacquire_lost_sessions",
};

test("a generic connection keeps the handover payload", () => {
  expect(livenessHandoverNotificationPayloads(handover)).toEqual([
    livenessHandoverPayload(handover),
  ]);
});

test("a daemon release reason names the managed loss without changing the generic payload", () => {
  const released: LivenessHandover = {
    ...handover,
    releaseReasons: { [SESSION]: "rehydration-owner-timeout" },
  };
  expect(livenessHandoverNotificationPayloads(released, readyManagedSlotsResult(SESSION))).toEqual([
    managedEndedPayload(readyManagedSlotsResult(SESSION), SESSION, "rehydration-owner-timeout"),
  ]);
  expect(livenessHandoverNotificationPayloads(released)).toEqual(
    livenessHandoverNotificationPayloads(handover),
  );
  expect(livenessHandoverPayload(released)).toEqual(livenessHandoverPayload(handover));
});

const stalled: LivenessHandover = {
  ...handover,
  code: "daemon_stalled",
  attempts: 3,
  action: "restart_daemon_then_resume_by_session_uuid",
};

test("a managed daemon stall tells the agent to wait for automatic reclaim", () => {
  const generic = livenessHandoverPayload(stalled);
  const payloads = livenessHandoverNotificationPayloads(stalled, readyManagedSlotsResult(SESSION));
  expect(payloads).toHaveLength(1);
  const payload = payloads[0] as typeof generic;
  expect(payload.error.recovery.action).toBe("wait_for_managed_reclaim");
  expect(payload.error.message).toContain(SESSION);
  expect(payload.error.message).toContain("3 automatic recovery attempts");
  expect(payload.error.message).toContain("keeps probing every heartbeat interval");
  expect(payload.error.message).toContain(
    "reclaims the session itself once a daemon answers again",
  );
  expect(payload.error.message).toContain("Do not pass a sessionUuid or try to acquire a device");
  expect(payload.error.message).toContain("retry the call later");
  expect(payload.error.message).toContain("never restarts the daemon because it is shared");
  expect(payload.error.message).toContain(
    "restarting it or relaunching the execution is the runner's decision",
  );
  expect(payload.error.message).toContain("calls answer managed_execution_ended");
  expect(payload.error.message).not.toContain("restart the daemon yourself");
  expect(payload.error.message).not.toContain("passing its sessionUuid");
  expect(payload).toEqual({
    error: {
      ...generic.error,
      message: payload.error.message,
      recovery: { action: "wait_for_managed_reclaim" },
    },
  });
  expect(Object.keys(payload.error)).toEqual(Object.keys(generic.error));
});

test("generic and failed managed daemon stalls keep the generic payload byte for byte", () => {
  const failed = { ...readyManagedSlotsResult(SESSION), outcome: "failed" as const };
  for (const managedSlots of [undefined, failed]) {
    const payloads = livenessHandoverNotificationPayloads(stalled, managedSlots);
    expect(payloads).toEqual([livenessHandoverPayload(stalled)]);
    expect(JSON.stringify(payloads[0])).toBe(JSON.stringify(livenessHandoverPayload(stalled)));
  }
});

test("a mixed daemon stall keeps non-slot sessions on the generic notification", () => {
  const other = { ...stalled.sessions[0], sessionUuid: OTHER };
  const mixed = { ...stalled, sessions: [other, stalled.sessions[0]] };
  const managed = livenessHandoverNotificationPayloads(stalled, readyManagedSlotsResult(SESSION));
  expect(livenessHandoverNotificationPayloads(mixed, readyManagedSlotsResult(SESSION))).toEqual([
    ...managed,
    livenessHandoverPayload({ ...mixed, sessions: [other] }),
  ]);
});

test("a daemon stall with only non-slot sessions keeps the generic notification byte for byte", () => {
  const payloads = livenessHandoverNotificationPayloads(stalled, readyManagedSlotsResult(OTHER));
  expect(payloads).toEqual([livenessHandoverPayload(stalled)]);
  expect(JSON.stringify(payloads[0])).toBe(JSON.stringify(livenessHandoverPayload(stalled)));
});

test("a lost session that is not one of the connection's slots keeps the handover", () => {
  const managedSlots = readyManagedSlotsResult(SESSION);
  const other = { ...handover.sessions[0], sessionUuid: OTHER };
  const mixed = { ...handover, sessions: [handover.sessions[0], other] };
  expect(livenessHandoverNotificationPayloads(mixed, managedSlots)).toEqual([
    managedEndedPayload(managedSlots, SESSION, "session-not-found"),
    livenessHandoverPayload({ ...handover, sessions: [other] }),
  ]);
});

test("a multi-session handover reports each managed session's own reason", () => {
  const managedSlots = readyManagedSlotsResult(SESSION);
  managedSlots.slots.push({ ...managedSlots.slots[0], slotIndex: 2, sessionUuid: OTHER });
  const mixed = {
    ...handover,
    sessions: [handover.sessions[0], { ...handover.sessions[0], sessionUuid: OTHER }],
    releaseReasons: { [SESSION]: "heartbeat-timeout", [OTHER]: "daemon-shutdown" },
  };
  expect(livenessHandoverNotificationPayloads(mixed, managedSlots)).toEqual([
    managedEndedPayload(managedSlots, SESSION, "heartbeat-timeout"),
    managedEndedPayload(managedSlots, OTHER, "daemon-shutdown"),
  ]);
  expect(livenessHandoverPayload(mixed)).toEqual(
    livenessHandoverPayload({ ...mixed, releaseReasons: undefined }),
  );
});
