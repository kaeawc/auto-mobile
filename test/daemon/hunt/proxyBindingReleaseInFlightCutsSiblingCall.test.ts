import { afterEach, beforeAll, expect, test } from "bun:test";
import { KEEPER_INTERVAL_MS, LivenessScenario } from "../../helpers/livenessScenarioHarness";

// HUNT (proxy-cli-ingress-parity-1): one stdio proxy holding two sessions on its one daemon
// connection, driven end to end: the real proxy and daemon client, the real daemon, socket server
// and session manager over an in-memory wire and database (LivenessScenario).
//
// Another client releases ONE of the two sessions (`--daemon release-session`, the desktop) and
// that release is still in flight when the proxy's next keeper tick heartbeats the session (here
// its database write takes longer than the 2 s tick). The daemon answers a heartbeat for a session
// that is being released with a bare not-found: no release reason yet, no release notification yet.
//
// When the session being released is one the proxy holds beside its binding, the answer is that
// session's alone and nothing else is touched. When it is the proxy's latest binding, the proxy
// "asks again on a fresh connection": it closes the one shared daemon socket. The control call
// the agent has in flight on the OTHER session, which nobody released, is cancelled in the daemon
// mid-run and answered "may or may not have run on the device".

const SIBLING_DEVICE = "emulator-5554";
const BINDING_DEVICE = "emulator-5556";

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

/**
 * The proxy acquires two devices, has a control call in flight on `callOn`, and another client
 * explicitly releases `released` with a release write that outlasts one keeper tick. Returns what
 * the caller of the in-flight call was answered and what reached the device boundary.
 */
async function releaseOneWhileTheOtherIsDriven(roles: {
  callOn: "sibling" | "binding";
  released: "sibling" | "binding";
}): Promise<{ answered: string; drove: Array<string | undefined>; callSessionHeld: boolean }> {
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

  const writes = holdReleaseWrites();
  const release = scenario.daemonMethod("daemon/releaseSession", {
    sessionId: sessions[roles.released],
  });
  // One keeper tick lands while the release is still in flight.
  await scenario.idle(KEEPER_INTERVAL_MS);
  const callSessionHeld = scenario.isHeld(sessions[roles.callOn]);
  writes.finish();
  await release;
  await call.settle();

  const failure = call.failure();
  return {
    answered: failure instanceof Error ? failure.name : "result",
    drove: scenario.driven.map((run) => run.sessionUuid),
    callSessionHeld,
  };
}

test("control: a held sibling's release in flight leaves the call on the binding alone", async () => {
  const outcome = await releaseOneWhileTheOtherIsDriven({ callOn: "binding", released: "sibling" });

  expect(outcome).toEqual({
    answered: "result",
    drove: ["scenario-session-2"],
    callSessionHeld: true,
  });
});

test("the binding's release in flight leaves the control call on the held sibling alone", async () => {
  const outcome = await releaseOneWhileTheOtherIsDriven({ callOn: "sibling", released: "binding" });

  // Nobody released the sibling: its session is still held, so its call runs to its result.
  expect(outcome).toEqual({
    answered: "result",
    drove: ["scenario-session-1"],
    callSessionHeld: true,
  });
});
