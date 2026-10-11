import { afterEach, beforeAll, expect, test } from "bun:test";
import { deviceRestartReleaseReason } from "../../../src/db/deviceSessionRepository";
import { KEEPER_INTERVAL_MS, LivenessScenario } from "../../helpers/livenessScenarioHarness";

// HUNT (proxy-cli-ingress-parity-1): one stdio proxy holding two sessions on its one daemon
// connection, driven end to end: the real proxy and daemon client, the real daemon, socket server
// and session manager over an in-memory wire and database (LivenessScenario).
//
// ONE of the two sessions goes away while the agent has a control call in flight on the OTHER,
// which nobody released. Two ways it goes:
//
// - Another client releases it (`--daemon release-session`, the desktop) and the release is still
//   in flight at the proxy's next keeper tick (here its database write outlasts the 2 s tick). The
//   daemon answers a heartbeat for a session being released with a bare not-found: no release
//   reason yet, no release notification yet.
// - Its device is lost and recovery hands the session off (`device-restart:<device>`), which the
//   daemon announces at once.
//
// When the session is one the proxy holds beside its binding, that is the session's own business
// and nothing else is touched. When it is the proxy's latest binding, the proxy goes to a fresh
// connection for it (the bare answer is "asked again", the handoff is reclaimed): it closes the
// one shared daemon socket without waiting for the calls in flight on it. The sibling's control
// call is cancelled in the daemon mid-run and answered "may or may not have run on the device".
// The same reset waits for calls in flight when the daemon is shutting down (#11634).

const SIBLING_DEVICE = "emulator-5554";
const BINDING_DEVICE = "emulator-5556";

type Role = "sibling" | "binding";

let scenario: LivenessScenario;

// The first scenario pays the one-time module and tool-registry cost; keep it out of the tests.
beforeAll(async () => {
  scenario = await LivenessScenario.start({ devices: [SIBLING_DEVICE, BINDING_DEVICE] });
  await scenario.acquire(SIBLING_DEVICE);
  await scenario.stop();
});

afterEach(async () => {
  await scenario.stop();
});

/** The daemon's release write stays in flight until `finish()`: a slow database, nothing more. */
function holdReleaseWrites(): { finish(): void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  const repository = scenario.repository;
  const markReleased = repository.markReleased.bind(repository);
  repository.markReleased = async (...args) => {
    await promise;
    return await markReleased(...args);
  };
  return { finish: resolve };
}

/** Another client's explicit release whose write outlasts one keeper tick. */
async function explicitReleaseInFlightAcrossATick(sessionId: string): Promise<void> {
  const writes = holdReleaseWrites();
  const release = scenario.daemonMethod("daemon/releaseSession", { sessionId });
  await scenario.idle(KEEPER_INTERVAL_MS);
  writes.finish();
  await release;
}

/**
 * The session's device is lost and handed off for its restart, as session-preserving recovery
 * releases it (`releaseDisconnectedRecoverySessionWithRetry`), then one keeper tick passes.
 */
async function deviceRestartHandoff(sessionId: string): Promise<void> {
  const manager = scenario.daemon.manager;
  const stableDeviceId = manager.getSession(sessionId)?.stableDeviceId ?? sessionId;
  await manager.releaseSession(sessionId, deviceRestartReleaseReason(stableDeviceId));
  await scenario.idle(KEEPER_INTERVAL_MS);
}

/**
 * The proxy acquires two devices and has a control call in flight on `callOn` when `gone` goes
 * away through `leave`. Returns what the caller of the in-flight call was answered, what reached
 * the device boundary, and whether the call's own session was still held throughout.
 */
async function oneSessionGoesWhileTheOtherIsDriven(
  roles: { callOn: Role; gone: Role },
  leave: (sessionId: string) => Promise<void>,
): Promise<{ answered: string; drove: Array<string | undefined>; callSessionHeld: boolean }> {
  scenario = await LivenessScenario.start({ devices: [SIBLING_DEVICE, BINDING_DEVICE] });
  const sessions = {
    sibling: await scenario.acquire(SIBLING_DEVICE),
    // Acquired last: the connection's binding. The first stays held beside it.
    binding: await scenario.acquire(BINDING_DEVICE),
  };
  // Both sessions are acknowledged on this connection before anything goes wrong.
  await scenario.idle(KEEPER_INTERVAL_MS);
  const call = scenario.startLongCall(sessions[roles.callOn]);
  await scenario.idle(KEEPER_INTERVAL_MS / 2);

  await leave(sessions[roles.gone]);
  const callSessionHeld = scenario.isHeld(sessions[roles.callOn]);
  await call.settle();

  const failure = call.failure();
  return {
    answered: failure instanceof Error ? failure.name : "result",
    drove: scenario.driven.map((run) => run.sessionUuid),
    callSessionHeld,
  };
}

const SIBLING_CALL_UNDISTURBED = {
  answered: "result",
  drove: ["scenario-session-1"],
  callSessionHeld: true,
};
const BINDING_CALL_UNDISTURBED = {
  answered: "result",
  drove: ["scenario-session-2"],
  callSessionHeld: true,
};

test("control: a held sibling's explicit release in flight leaves the call on the binding alone", async () => {
  const outcome = await oneSessionGoesWhileTheOtherIsDriven(
    { callOn: "binding", gone: "sibling" },
    explicitReleaseInFlightAcrossATick,
  );

  expect(outcome).toEqual(BINDING_CALL_UNDISTURBED);
});

test("control: a held sibling's device-restart handoff leaves the call on the binding alone", async () => {
  const outcome = await oneSessionGoesWhileTheOtherIsDriven(
    { callOn: "binding", gone: "sibling" },
    deviceRestartHandoff,
  );

  expect(outcome).toEqual(BINDING_CALL_UNDISTURBED);
});

test("the binding's explicit release in flight leaves the control call on the held sibling alone", async () => {
  const outcome = await oneSessionGoesWhileTheOtherIsDriven(
    { callOn: "sibling", gone: "binding" },
    explicitReleaseInFlightAcrossATick,
  );

  // Nobody released the sibling: its session is still held, so its call runs to its result.
  expect(outcome).toEqual(SIBLING_CALL_UNDISTURBED);
});

test("the binding's device-restart handoff leaves the control call on the held sibling alone", async () => {
  const outcome = await oneSessionGoesWhileTheOtherIsDriven(
    { callOn: "sibling", gone: "binding" },
    deviceRestartHandoff,
  );

  // The other device restarted, not this one: the sibling's call runs to its result.
  expect(outcome).toEqual(SIBLING_CALL_UNDISTURBED);
});
