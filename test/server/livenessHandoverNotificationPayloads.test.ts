import { expect, test } from "bun:test";
import { livenessHandoverNotificationPayloads } from "../../src/server/proxyServer";
import {
  livenessHandoverPayload,
  type LivenessHandover,
} from "../../src/daemon/proxyLivenessRecovery";

// #11483 item 1: which logging notifications one liveness handover becomes. The end-to-end answer
// is covered in managedProxyStalledLossAnswer.test.ts; this pins the cases that harness cannot
// reach cheaply (a daemon stall, and a handover listing a session that is not a slot).

const SESSION = "11111111-2222-4333-8444-555555555555";

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

const stalled: LivenessHandover = {
  ...handover,
  code: "daemon_stalled",
  attempts: 3,
  action: "restart_daemon_then_resume_by_session_uuid",
};

test("a daemon stall with only non-binding sessions keeps the generic notification byte for byte", () => {
  const payloads = livenessHandoverNotificationPayloads(stalled);
  expect(payloads).toEqual([livenessHandoverPayload(stalled)]);
  expect(JSON.stringify(payloads[0])).toBe(JSON.stringify(livenessHandoverPayload(stalled)));
});
