import { afterEach, beforeAll, expect, test } from "bun:test";
import type { DaemonClientLike } from "../../src/daemon/client/client";
import { DAEMON_VERSION } from "../../src/daemon/wire/constants";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DAEMON_SESSION_NOT_FOUND_CODE } from "../../src/daemon/types";
import { deviceRestartReleaseReason } from "../../src/db/deviceSessionRepository";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  KEEPER_INTERVAL_MS,
  LivenessScenario,
  NO_HEARTBEAT_BUDGET_MS,
} from "../helpers/livenessScenarioHarness";

// One stdio proxy holding two sessions on its one daemon connection (#11656), driven end to end:
// the real proxy and daemon client, the real daemon, socket server and session manager over an
// in-memory wire and database (LivenessScenario).
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
// Either is that session's own business, whether it is one the proxy holds beside its binding or
// the binding itself. With nothing else in flight the proxy asks about its binding on a fresh
// connection (the bare answer is asked again, the handoff is reclaimed). With a call in flight it
// asks on the connection it has: closing the one shared daemon socket would cancel the other
// session's control call in the daemon mid-run and answer it "may or may not have run on the
// device". A connection that is going away as a whole (daemon shutdown, a dead transport) is
// another matter: proxyHeartbeatStateMachine.property.test.ts and daemonRestartEndToEnd.test.ts.

const SIBLING_DEVICE = "emulator-5554";
const BINDING_DEVICE = "emulator-5556";

/** A control tool, as the scenario's long call is. */
const CONTROL_TOOL = "homeScreen";

type Role = "sibling" | "binding";

let scenario: LivenessScenario;

// A throwaway scenario pays the one-time cost of loading the modules and the tool registry and of
// first running a call, a keeper tick and a release. Every test still builds its own scenario.
beforeAll(async () => {
  scenario = await LivenessScenario.start({ devices: [SIBLING_DEVICE, BINDING_DEVICE] });
  const sessionId = await scenario.acquire(SIBLING_DEVICE);
  const call = scenario.startLongCall(sessionId);
  await scenario.idle(KEEPER_INTERVAL_MS);
  await call.settle();
  await scenario.daemonMethod("daemon/releaseSession", { sessionId });
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
    drove: driven(),
    callSessionHeld,
  };
}

/**
 * Time passes as on a wall clock: in steps much shorter than a keeper tick, so an answer the
 * daemon is still composing arrives before the next tick rather than with it.
 */
async function wallClock(ms: number): Promise<void> {
  const stepMs = KEEPER_INTERVAL_MS / 10;
  for (let passed = 0; passed < ms; passed += stepMs) {
    await scenario.idle(stepMs);
  }
}

/** The session of every command that reached the device boundary, in order. */
function driven(): Array<string | undefined> {
  return scenario.driven.map((run) => run.sessionUuid);
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

test("the binding's explicit release during the sibling's call is still reported: a later sessionless control call drives nothing", async () => {
  const outcome = await oneSessionGoesWhileTheOtherIsDriven(
    { callOn: "sibling", gone: "binding" },
    explicitReleaseInFlightAcrossATick,
  );
  // The agent's next call names no session: it was going to the device that was just released.
  const next = await scenario.proxy.callTool(CONTROL_TOOL, {}).then(
    () => "forwarded",
    (error: unknown) => (error instanceof Error ? error.name : String(error)),
  );

  expect({ ...outcome, next, drove: driven() }).toEqual({
    ...SIBLING_CALL_UNDISTURBED,
    // Told its session is gone (#11656), never sent to the sibling's device.
    next: "DaemonConnectionSessionReleasedError",
  });
});

test("both sessions are heartbeated on every tick while the sibling's call outlasts the handoff", async () => {
  scenario = await LivenessScenario.start({ devices: [SIBLING_DEVICE, BINDING_DEVICE] });
  const sibling = await scenario.acquire(SIBLING_DEVICE);
  const binding = await scenario.acquire(BINDING_DEVICE);
  await scenario.idle(KEEPER_INTERVAL_MS);
  const call = scenario.startLongCall(sibling);
  await deviceRestartHandoff(binding);
  // The tick that hears of the handoff asks the binding twice: count from the next one on, and
  // between two ticks, where every heartbeat of the ticks counted has been answered.
  await wallClock(1.5 * KEEPER_INTERVAL_MS);
  const asked = () => ({
    sibling: scenario.heartbeatsBySession.get(sibling) ?? 0,
    binding: scenario.heartbeatsBySession.get(binding) ?? 0,
  });
  const before = asked();

  // The whole no-heartbeat release budget: a keeper waiting behind the call would lose both.
  const ticks = NO_HEARTBEAT_BUDGET_MS / KEEPER_INTERVAL_MS;
  await wallClock(ticks * KEEPER_INTERVAL_MS);
  const after = asked();
  const siblingHeld = scenario.isHeld(sibling);
  await call.settle();

  expect({
    sibling: after.sibling - before.sibling,
    binding: after.binding - before.binding,
    siblingHeld,
    answered: call.failure() ?? "result",
    drove: driven(),
  }).toEqual({
    sibling: ticks,
    binding: ticks,
    siblingHeld: true,
    answered: "result",
    drove: [sibling],
  });
});

test("the binding's device-restart handoff leaves the control call on the held sibling alone", async () => {
  const outcome = await oneSessionGoesWhileTheOtherIsDriven(
    { callOn: "sibling", gone: "binding" },
    deviceRestartHandoff,
  );

  // The other device restarted, not this one: the sibling's call runs to its result.
  expect(outcome).toEqual(SIBLING_CALL_UNDISTURBED);
});

// The daemon in the scenarios above makes a tool call wait for its session's release, so this one
// answer is scripted: a control call answered a bare not-found for its own session.
test("a control call answered not-found for its own session is not sent again and closes nothing", async () => {
  const held = Promise.withResolvers<void>();
  const client = new FakeDaemonClient({
    onCallTool: (_name, params) => {
      if (params.sessionUuid === "sibling") {
        return held.promise;
      }
      throw Object.assign(new Error(`Session not found: ${params.sessionUuid}`), {
        code: DAEMON_SESSION_NOT_FOUND_CODE,
      });
    },
  });
  const daemonManager = new FakeDaemonManager();
  daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
  const proxy = new DaemonMcpProxy({
    clientFactory: (): DaemonClientLike => client,
    daemonAvailabilityProbe: async () => true,
    daemonManager,
    autoStartDaemon: false,
    timer: new FakeTimer(),
    idGenerator: new FakeIdGenerator(),
  });
  const nameOf = (error: unknown) => (error instanceof Error ? error.name : String(error));

  const siblingCall = proxy.callTool("tapOn", { sessionUuid: "sibling", text: "Upload" });
  const answered = await proxy
    .callTool("tapOn", { sessionUuid: "gone", text: "Continue" })
    .then(() => "result", nameOf);
  const connectedMeanwhile = client.isConnected();
  held.resolve();
  const sibling = await siblingCall.then(() => "result", nameOf);
  await proxy.close();

  expect({
    answered,
    connectedMeanwhile,
    sibling,
    sent: client.callToolCalls.map((call) => call.params.sessionUuid),
  }).toEqual({
    answered: "DaemonToolOutcomeUnknownError",
    connectedMeanwhile: true,
    sibling: "result",
    sent: ["sibling", "gone"],
  });
});
