import { afterEach, describe, expect, test } from "bun:test";
import { DaemonUnavailableError } from "../../src/daemon/client";
import type { SlotKey } from "../../src/daemon/managedSlots/slotRegistry";
import {
  ManagedExecutionScenario,
  type ManagedExecution,
} from "../helpers/managedExecutionScenario";

// A managed execution whose proxy is stopped by a signal while one of its tool calls is in flight
// (#11642 item 2). See managedExecutionScenario.ts for what is real (the Daemon, its managed-slot
// wiring, the SQLite slot registry, the control socket and the stdio proxy) and what is the device
// boundary.

const DEVICE = "emulator-5554";

let s: ManagedExecutionScenario;
let key: SlotKey;

async function started(): Promise<ManagedExecution> {
  s = await ManagedExecutionScenario.start();
  key = await s.assignSlot(DEVICE);
  const execution = await s.launchExecution();
  expect(execution.result.slots[0]).toMatchObject({ disposition: "reused" });
  return execution;
}

interface CallInFlight {
  /** How the call ended for its caller, once it has. */
  outcome(): { answered?: unknown; threw?: unknown } | undefined;
}

/**
 * The execution's tool call, left in flight at the device boundary until the daemon stops it. No
 * caller signal: the MCP server is still open, so nothing aborts the request.
 */
function callInFlight(execution: ManagedExecution, wedged = false): CallInFlight {
  let outcome: { answered?: unknown; threw?: unknown } | undefined;
  const gates = Reflect.get(s.scenario, "gates") as Map<string, unknown>;
  gates.set(execution.sessionUuid!, { opened: new Promise<void>(() => {}), wedged });
  void execution.proxy.callTool("tapOn", { sessionUuid: execution.sessionUuid }).then(
    (answered: unknown) => {
      outcome = { answered };
    },
    (threw: unknown) => {
      outcome = { threw };
    },
  );
  return { outcome: () => outcome };
}

afterEach(async () => {
  await s?.stop();
});

describe("a proxy stopped by a signal while one of its tool calls is in flight", () => {
  test("the daemon drains and releases the execution within the proxy's release bound", async () => {
    const execution = await started();
    const session = execution.sessionUuid!;
    // The agent's call is on the device when the runner cancels the job and signals the proxy:
    // the process shutdown handler (src/index.ts, "stdio proxy" stage) runs `proxy.close()` with
    // the MCP server still open, so nothing else has cancelled the call.
    const inFlight = callInFlight(execution);
    await s.idle(300);
    expect(s.scenario.driven.at(-1)).toBeDefined();

    // MANAGED_EXECUTION_RELEASE_TIMEOUT_MS (1.5 s) bounds the proxy's release; give it 2.5 s.
    await s.during(execution.proxy.close(), 2_500);

    // docs/using/managed-slots.md, "Drain and release": when the execution ends (stdin EOF,
    // cancellation or owner loss) the daemon cancels the session's in-flight work, waits about
    // 500 ms for it, then releases the session.
    const snapshot = await s.restart.snapshot(session, DEVICE);
    expect({
      held: snapshot.held,
      row: snapshot.row,
      owner: (await s.slot(key))?.owner ?? null,
      releaseReasons: s.scenario.releases.map((release) => release.reason),
    }).toEqual({
      held: false,
      row: { released: true, reason: "explicit-release" },
      owner: null,
      releaseReasons: ["explicit-release"],
    });
    // The call's own caller is answered, never left hanging.
    const { threw } = inFlight.outcome() ?? {};
    expect(threw).toBeInstanceOf(DaemonUnavailableError);
    expect(String(threw)).toContain("MCP proxy is closing");
  });

  test("a call wedged on the device does not hold the release: the slot settles behind it", async () => {
    const execution = await started();
    const session = execution.sessionUuid!;
    const inFlight = callInFlight(execution, true);
    await s.idle(300);

    await s.during(execution.proxy.close(), 2_500);

    // The cancel frees the socket's queue at once, whether or not the device command stops: the
    // release is admitted, and the slot is protected (`settling`) until the work ends.
    const snapshot = await s.restart.snapshot(session, DEVICE);
    expect({
      held: snapshot.held,
      row: snapshot.row,
      slot: await s.slot(key),
      releaseReasons: s.scenario.releases.map((release) => release.reason),
    }).toMatchObject({
      held: false,
      row: { released: true, reason: "explicit-release" },
      slot: { state: "settling", owner: null },
      releaseReasons: ["explicit-release"],
    });
    expect(inFlight.outcome()?.threw).toBeInstanceOf(DaemonUnavailableError);
  });
});
