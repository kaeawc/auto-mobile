import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DaemonUnavailableError } from "../../src/daemon/client";
import type { SlotKey } from "../../src/daemon/managedSlots/slotRegistry";
import {
  ManagedExecutionScenario,
  SCOPE,
  type ManagedExecution,
} from "../helpers/managedExecutionScenario";

// A managed execution whose proxy is stopped by a signal while one of its tool calls is in flight
// (#11642 item 2). See managedExecutionScenario.ts for what is real (the Daemon, its managed-slot
// wiring, the SQLite slot registry, the control socket and the stdio proxy) and what is the device
// boundary.
//
// One daemon serves the file: building it and launching an execution is the same warm-up for every
// case (module loading, the daemon's start, the slot acquisition's real I/O), so it runs once in
// `beforeAll`. Each case has its own runner, slot, device, proxy connection and session, and reads
// only its own session's releases.

interface Launched {
  device: string;
  key: SlotKey;
  execution: ManagedExecution;
  session: string;
}

let s: ManagedExecutionScenario;
let stopped: Launched;
let wedged: Launched;
/** Ends each device command a case left running. */
const deviceCommands: Array<() => void> = [];

async function launch(device: string, runnerNamespace: string): Promise<Launched> {
  const scope = { ...SCOPE, runnerNamespace };
  const key = await s.assignSlot(device, scope);
  const execution = await s.launchExecution(scope);
  expect(execution.result.slots[0]).toMatchObject({ disposition: "reused" });
  return { device, key, execution, session: execution.sessionUuid! };
}

interface CallInFlight {
  /** How the call ended for its caller, once it has. */
  outcome(): { answered?: unknown; threw?: unknown } | undefined;
}

/**
 * The execution's tool call, left in flight at the device boundary until the daemon stops it. No
 * caller signal: the MCP server is still open, so nothing aborts the request.
 */
function callInFlight({ execution, session }: Launched, isWedged = false): CallInFlight {
  let outcome: { answered?: unknown; threw?: unknown } | undefined;
  const gates = Reflect.get(s.scenario, "gates") as Map<string, unknown>;
  const opened = new Promise<void>((resolve) => deviceCommands.push(resolve));
  gates.set(session, { opened, wedged: isWedged });
  void execution.proxy.callTool("tapOn", { sessionUuid: session }).then(
    (answered: unknown) => {
      outcome = { answered };
    },
    (threw: unknown) => {
      outcome = { threw };
    },
  );
  return { outcome: () => outcome };
}

const releaseReasons = (session: string) =>
  s.scenario.releases
    .filter((release) => release.sessionId === session)
    .map((release) => release.reason);

beforeAll(async () => {
  s = await ManagedExecutionScenario.start({
    devices: ["emulator-5554", "emulator-5556", "emulator-5558"],
  });
  stopped = await launch("emulator-5554", "runner-A");
  wedged = await launch("emulator-5556", "runner-B");
  // Warm-up only, on a third execution of its own: the first tool call and the first proxy close
  // in a process load the tool path and the release path. Nothing is asserted about it.
  const warmUp = await launch("emulator-5558", "runner-W");
  const call = warmUp.execution.proxy.callTool("tapOn", { sessionUuid: warmUp.session });
  await s.during(
    call.catch(() => undefined),
    1_500,
    500,
  );
  await s.during(warmUp.execution.proxy.close(), 1_500, 500);
});

afterAll(async () => {
  // A wedged device command ends here: the execution tracker is process-wide, and the file shares
  // its test process.
  for (const finish of deviceCommands.splice(0)) {
    finish();
  }
  await s?.idle(0);
  await s?.stop();
});

describe("a proxy stopped by a signal while one of its tool calls is in flight", () => {
  test("the daemon drains and releases the execution within the proxy's release bound", async () => {
    const { execution, session, device, key } = stopped;
    // The agent's call is on the device when the runner cancels the job and signals the proxy:
    // the process shutdown handler (src/index.ts, "stdio proxy" stage) runs `proxy.close()` with
    // the MCP server still open, so nothing else has cancelled the call.
    const inFlight = callInFlight(stopped);
    await s.idle(300);
    expect(s.scenario.driven.at(-1)).toMatchObject({ sessionUuid: session });
    expect(inFlight.outcome()).toBeUndefined();

    // MANAGED_EXECUTION_RELEASE_TIMEOUT_MS (1.5 s) bounds the proxy's release: `during` throws if
    // the close has not settled by then.
    await s.during(execution.proxy.close(), 1_500, 500);

    // docs/using/managed-slots.md, "Drain and release": when the execution ends (stdin EOF,
    // cancellation or owner loss) the daemon cancels the session's in-flight work, waits about
    // 500 ms for it, then releases the session.
    const snapshot = await s.restart.snapshot(session, device);
    expect({
      held: snapshot.held,
      row: snapshot.row,
      owner: (await s.slot(key))?.owner ?? null,
      releaseReasons: releaseReasons(session),
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
    const { execution, session, device, key } = wedged;
    const inFlight = callInFlight(wedged, true);
    await s.idle(300);
    expect(inFlight.outcome()).toBeUndefined();

    await s.during(execution.proxy.close(), 1_500, 500);

    // The cancel frees the socket's queue at once, whether or not the device command stops: the
    // release is admitted, and the slot is protected (`settling`) until the work ends.
    const snapshot = await s.restart.snapshot(session, device);
    expect({
      held: snapshot.held,
      row: snapshot.row,
      slot: await s.slot(key),
      releaseReasons: releaseReasons(session),
    }).toMatchObject({
      held: false,
      row: { released: true, reason: "explicit-release" },
      slot: { state: "settling", owner: null },
      releaseReasons: ["explicit-release"],
    });
    expect(inFlight.outcome()?.threw).toBeInstanceOf(DaemonUnavailableError);
  });
});
