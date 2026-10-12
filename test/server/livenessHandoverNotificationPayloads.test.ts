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

test("a daemon stall is not a loss: a managed connection keeps its handover", () => {
  const stalled = { ...handover, code: "daemon_stalled" as const };
  expect(livenessHandoverNotificationPayloads(stalled, readyManagedSlotsResult(SESSION))).toEqual([
    livenessHandoverPayload(stalled),
  ]);
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
