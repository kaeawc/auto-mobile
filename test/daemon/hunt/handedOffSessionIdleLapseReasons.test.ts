import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";
import {
  IDLE_WINDOW_MS,
  LivenessScenario,
  RELEASE_SLACK_MS,
} from "../../helpers/livenessScenarioHarness";
import {
  DEVICE_A,
  DEVICE_B,
  DISCONNECT_POLL_MS,
  forbidHostCommands,
  mcpVerdict,
  persistedRow,
  releasesOf,
  sessionInfo,
  socketVerdict,
  startDisconnectMonitor,
  type WireVerdict,
} from "./timerInteractionRig";

// Hunt 2026-10-10, lifecycle timer interactions: T3 (device loss) x restart recovery x T2 (idle).
//
// The disconnect monitor hands a held emulator's session off recoverably when the device goes
// away: the session is released as `device-restart:<id>`, its row is `released` with that reason,
// and the owner resumes by naming the UUID. The handoff does not stop the idle clock: the row
// keeps the idle deadline of the last control call, and a call naming the UUID after that deadline
// is refused terminally (`session_ownership_lost` / `acquire_new_session`).
//
// So the session ENDS at its idle deadline, but nothing records or announces that end. No release
// runs (the session is not in memory), so the row is never rewritten, `daemon/sessionInfo` keeps
// answering with the recoverable `device-restart:<id>` reason, and the owner's proxy is never
// told. One ended session is then reported three ways:
//
//   daemon socket, control call   session_ownership_lost, reason `expired`
//   daemon/sessionInfo            releaseReason `device-restart:Pixel_emulator-5554` (recoverable)
//   persisted row                 status `released`, reason `device-restart:Pixel_emulator-5554`
//   owner's MCP result            session_ownership_lost, reason `replay-lease-expired`
//
// A status client that reads `device-restart:` is told the session is resumable by name; naming it
// is refused for good. Every other way a session ends at its idle deadline (the baselines beside
// this file) names one reason on all four.

const HANDOFF_REASON = `device-restart:Pixel_${DEVICE_A}`;
const TERMINAL = { code: "session_ownership_lost", nextAction: "acquire_new_session" };
/** Microtask turns that let a whole admission or re-bind chain finish. */
const QUIET_TURNS = 400;

let scenario: LivenessScenario;

// Fake-only: no scenario here, the warm-up included, may launch a host or adb command.
forbidHostCommands();

beforeAll(async () => {
  const warm = await LivenessScenario.start();
  const session = await warm.acquire();
  await warm.toolCall(session);
  await warm.idleUntilReleased(session, IDLE_WINDOW_MS + RELEASE_SLACK_MS);
  await warm.stop();
});

afterEach(async () => {
  await scenario.stop();
});

/**
 * A session used at t=0 whose emulator disappears: handed off at the third absent sweep. The
 * emulator is back and free 20 s later, and nobody names the session until past its idle deadline.
 */
async function handedOffAndLeftPastItsIdleDeadline(): Promise<string> {
  scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B] });
  const listing = startDisconnectMonitor(scenario);
  const session = await scenario.acquire();
  await scenario.toolCall(session);

  listing.set(DEVICE_A, "absent");
  await scenario.idle(4 * DISCONNECT_POLL_MS);
  expect(releasesOf(scenario, session).map((release) => release.reason)).toEqual([HANDOFF_REASON]);
  expect(await persistedRow(scenario, session)).toMatchObject({
    status: "released",
    reason: HANDOFF_REASON,
  });

  listing.set(DEVICE_A, "device");
  await scenario.idle(IDLE_WINDOW_MS + 10_000 - scenario.timer.now());
  return session;
}

/** Ask once and let the answer arrive: admission is a promise chain, not a timer. */
async function answered(ask: Promise<WireVerdict>): Promise<WireVerdict> {
  let verdict: WireVerdict | undefined;
  void ask.then((answer) => {
    verdict = answer;
  });
  for (let step = 0; step < 20 && verdict === undefined; step++) {
    await drainMicrotasks(QUIET_TURNS);
    await scenario.idle(1_000);
  }
  return verdict ?? { code: "unanswered" };
}

describe("a device-restart handoff nobody resumes before its idle deadline", () => {
  test("the daemon's refusal, session-info and the persisted row name one reason", async () => {
    const session = await handedOffAndLeftPastItsIdleDeadline();

    // Control: the session has ended. The daemon refuses a control call terminally, twice.
    const refusal = await answered(socketVerdict(scenario, session));
    expect(refusal).toMatchObject(TERMINAL);
    expect(await answered(socketVerdict(scenario, session))).toEqual(refusal);
    expect(scenario.daemon.manager.getAllSessions()).toEqual([]);

    // The bug: the frame a status client reads and the row still say "recoverable handoff".
    const info = await sessionInfo(scenario, session);
    const row = await persistedRow(scenario, session);
    expect({
      sessionInfoReason: info.releaseReason,
      rowReason: row.reason,
      rowStillResumable: row.status === "released" && row.reason === HANDOFF_REASON,
    }).toEqual({
      sessionInfoReason: refusal.reason,
      rowReason: refusal.reason,
      rowStillResumable: false,
    });
  });

  test("the owner's MCP result names the reason the daemon gives", async () => {
    const session = await handedOffAndLeftPastItsIdleDeadline();

    // The owner's proxy was never told the session ended, so it answers from its own clock.
    const mcp = await answered(mcpVerdict(scenario, session));
    expect(mcp.code).toBe("DaemonBoundSessionExpiredError");
    const daemon = await answered(socketVerdict(scenario, session));
    expect(daemon).toMatchObject(TERMINAL);

    expect(mcp.reason).toBe(daemon.reason!);
  });
});
