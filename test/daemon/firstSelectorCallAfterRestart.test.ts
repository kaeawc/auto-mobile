import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { routedSessionUuidFromResult } from "../../src/daemon/routedSessionMeta";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { forbidHostCommands } from "../helpers/hostCommandGuard";
import { KEEPER_INTERVAL_MS } from "../helpers/livenessScenarioHarness";
import {
  RestartScenario,
  warmUpRestartScenario,
  type ShutdownKind,
} from "../helpers/restartScenarioHarness";

// #14668: after `stop` then `start`, the owner's FIRST device-selector control call
// (`{platform, deviceId}`, no sessionUuid) was refused with a non-retryable
// `device_owned_by_other_session` telling the owner to acquire its own device; the identical
// second call was routed to the owner's session. A clean stop announces each release as
// `daemon-shutdown`, which the proxy keeps as a recoverable handoff of its binding. The call's
// routing arguments were built while that marker was still set, so they left the binding out of
// the owned sessions the successor restores on the fresh connection; the reconnect then cleared
// the marker, so the next call carried it. Each run is a real Daemon, socket server and stdio
// proxy on one FakeTimer (restartScenarioHarness.ts).

forbidHostCommands();

beforeAll(warmUpRestartScenario);

const A = "emulator-5554";
const KINDS: ShutdownKind[] = ["clean", "crash"];
/** The issue's call shape: a control tool addressed by platform and device id, no session. */
const SELECTOR_ARGS = { orientation: "portrait", platform: "android", deviceId: A } as const;

let run: RestartScenario | undefined;

afterEach(async () => {
  await run?.stop();
  run = undefined;
});

interface Answer {
  result?: unknown;
  error?: unknown;
}

/** One proxy call with the scenario clock running while it waits; settles within 30 s. */
async function answered(call: () => Promise<unknown>): Promise<Answer> {
  let answer: Answer | undefined;
  void call().then(
    (result) => {
      answer = { result };
    },
    (error: unknown) => {
      answer = { error };
    },
  );
  for (let step = 0; step < 300 && answer === undefined; step++) {
    await drainMicrotasks(64);
    if (answer === undefined) {
      await run!.scenario.idle(100);
    }
  }
  if (answer === undefined) {
    throw new Error("the call was not answered within 30 s");
  }
  return answer;
}

/** What the caller was told, in words a failed assertion can show. */
function told(answer: Answer): string {
  if (answer.error !== undefined) {
    return answer.error instanceof Error ? answer.error.message : String(answer.error);
  }
  return JSON.stringify(answer.result);
}

/** The owner holds A, the daemon restarts, and the successor is up with nothing else elapsed. */
async function restartWithLiveOwner(kind: ShutdownKind): Promise<string> {
  run = await RestartScenario.start({ devices: [A] });
  const session = await run.scenario.acquire(A);
  await run.idle(3_000);
  await run.end(kind);
  await run.startSuccessor();
  return session;
}

describe("the owner's first selector control call after a daemon restart (#14668)", () => {
  for (const kind of KINDS) {
    // Before the proxy's keeper has ticked against the successor (it ticks every 2 s), so the
    // call itself is what reconnects and reclaims.
    for (const afterMs of [0, KEEPER_INTERVAL_MS / 4]) {
      test(`${kind} restart, call ${afterMs} ms after the successor starts: routed to the owner's own session`, async () => {
        const session = await restartWithLiveOwner(kind);
        if (afterMs > 0) {
          await run!.idle(afterMs);
        }

        const first = await answered(() => run!.scenario.proxy.callTool("rotate", SELECTOR_ARGS));

        expect(told(first)).not.toContain("device_owned_by_other_session");
        expect(first.result).not.toMatchObject({ isError: true });
        expect(routedSessionUuidFromResult(first.result)).toBe(session);
        expect(run!.scenario.driven.map((ran) => ran.sessionUuid)).toEqual([session]);
        expect(run!.scenario.poolState(A)).toMatchObject({ status: "busy", sessionId: session });
      });
    }

    test(`${kind} restart: another client's identical selector call is still refused`, async () => {
      const session = await restartWithLiveOwner(kind);
      const other = run!.scenario.addProxy({ token: "another-client" });

      const refused = await answered(() => other.callTool("rotate", SELECTOR_ARGS));
      const owner = await answered(() => run!.scenario.proxy.callTool("rotate", SELECTOR_ARGS));

      expect(told(refused)).toContain("device_owned_by_other_session");
      expect(routedSessionUuidFromResult(owner.result)).toBe(session);
      expect(run!.scenario.driven.map((ran) => ran.sessionUuid)).toEqual([session]);
    });
  }
});
