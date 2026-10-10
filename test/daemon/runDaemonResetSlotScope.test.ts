import { describe, expect, spyOn, test } from "bun:test";
import {
  parseResetSlotScopeCommandArgs,
  runDaemonCommand,
} from "../../src/daemon/cli/runDaemonCommand";
import { DAEMON_RESET_SLOT_SCOPE_METHOD } from "../../src/daemon/constants";
import type { DaemonStateLike } from "../../src/daemon/daemonState";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";

// #11174: `--daemon reset-slot-scope` asks the running daemon to invalidate one runner
// incarnation's managed slot scope.

const unexpected = (): never => {
  throw new Error("Unexpected local daemon access");
};
const remoteState: DaemonStateLike = {
  isInitialized: () => false,
  getSessionManager: unexpected,
  getDevicePool: unexpected,
  getDeviceSessionRegistry: unexpected,
};

async function run(args: string[], result: unknown) {
  const client = new FakeDaemonClient({
    daemonMethodResults: new Map([[DAEMON_RESET_SLOT_SCOPE_METHOD, result]]),
  });
  const output: unknown[] = [];
  const exited = new Error("fake exit");
  const log = spyOn(console, "log").mockImplementation((text) => output.push(["stdout", text]));
  const error = spyOn(console, "error").mockImplementation((text) => output.push(["stderr", text]));
  const exit = spyOn(process, "exit").mockImplementation((code) => {
    output.push(["exit", code]);
    throw exited;
  });
  try {
    await runDaemonCommand(
      "reset-slot-scope",
      args,
      { clientFactory: () => client, stateProvider: () => remoteState },
      SafeDaemonManager,
    ).catch((caught: unknown) => {
      if (caught !== exited) {
        throw caught;
      }
    });
    return { client, output };
  } finally {
    exit.mockRestore();
    error.mockRestore();
    log.mockRestore();
  }
}

describe("reset-slot-scope daemon command", () => {
  test("parses the scope selector and the bounded wait", () => {
    expect(
      parseResetSlotScopeCommandArgs([
        "--runner-namespace",
        "ns",
        "--incarnation",
        "boot-2",
        "--managed-host-scope",
        "host",
        "--wait-ms",
        "2500",
      ]),
    ).toEqual({
      runnerNamespace: "ns",
      runnerIncarnation: "boot-2",
      managedHostScope: "host",
      waitMs: 2500,
    });
    expect(
      parseResetSlotScopeCommandArgs(["--incarnation", "b", "--runner-namespace", "n"]),
    ).toEqual({ runnerNamespace: "n", runnerIncarnation: "b" });
  });

  test.each([
    { args: [], message: "requires --runner-namespace" },
    { args: ["--runner-namespace", "ns"], message: "requires --incarnation" },
    { args: ["--runner-namespace", "--incarnation", "b"], message: "non-empty value" },
    {
      args: ["--runner-namespace", "n", "--incarnation", "b", "--wait-ms", "-1"],
      message: "--wait-ms must be an integer",
    },
    {
      args: ["--runner-namespace", "n", "--incarnation", "b", "--wait-ms", "60001"],
      message: "--wait-ms must be an integer",
    },
  ])("rejects $args", ({ args, message }) => {
    expect(() => parseResetSlotScopeCommandArgs(args)).toThrow(message);
  });

  test("sends the RPC, prints the result and closes the connection", async () => {
    const result = { outcome: "invalidated", retryable: false, scopes: [], waitedMs: 0 };
    const { client, output } = await run(
      ["--runner-namespace", "ns", "--incarnation", "boot-1"],
      result,
    );
    expect(client.callDaemonMethodCalls).toEqual([
      {
        method: DAEMON_RESET_SLOT_SCOPE_METHOD,
        params: { runnerNamespace: "ns", runnerIncarnation: "boot-1" },
      },
    ]);
    expect(output).toEqual([["stdout", JSON.stringify(result)]]);
    expect(client.isConnected()).toBe(false);
  });

  test("a still-settling scope exits 2 so the operator retries", async () => {
    const { output } = await run(["--runner-namespace", "ns", "--incarnation", "boot-1"], {
      outcome: "pending",
      retryable: true,
      scopes: [],
      waitedMs: 10_000,
    });
    expect(output.slice(1)).toEqual([
      [
        "stderr",
        "Scope is still settling (live owners or pending cleanup); acquisitions stay blocked. Retry the command.",
      ],
      ["exit", 2],
    ]);
  });

  test("an unknown scope exits 1", async () => {
    const { output } = await run(["--runner-namespace", "ns", "--incarnation", "boot-9"], {
      outcome: "not_found",
      retryable: false,
      scopes: [],
      waitedMs: 0,
    });
    expect(output.at(-1)).toEqual(["exit", 1]);
  });
});
