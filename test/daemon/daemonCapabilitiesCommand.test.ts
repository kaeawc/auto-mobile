import { describe, expect, spyOn, test } from "bun:test";
import type { DaemonMethodCallOptions } from "../../src/daemon/client";
import { DaemonUnavailableError } from "../../src/daemon/client";
import {
  DAEMON_CAPABILITIES_COMMAND_USAGE,
  DAEMON_CAPABILITIES_TIMEOUT_MS,
  queryExistingDaemonCapabilities,
  type DaemonCapabilitiesCommandClient,
} from "../../src/daemon/cli/daemonCapabilitiesCommand";
import {
  daemonCommandArgumentError,
  runDaemonCommand,
} from "../../src/daemon/cli/runDaemonCommand";
import { DAEMON_CAPABILITIES_METHOD } from "../../src/daemon/daemonRequestHandlers";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";

class FakeCapabilitiesClient implements DaemonCapabilitiesCommandClient {
  readonly events: unknown[] = [];

  constructor(
    private readonly result: unknown,
    private readonly connectFailure?: Error,
    private readonly callFailure?: Error,
  ) {}

  async connect(): Promise<void> {
    this.events.push("connect");
    if (this.connectFailure) {
      throw this.connectFailure;
    }
  }

  async callDaemonMethod(
    method: string,
    params: Record<string, unknown>,
    options: DaemonMethodCallOptions,
  ): Promise<unknown> {
    this.events.push(["call", method, params, options]);
    if (this.callFailure) {
      throw this.callFailure;
    }
    return this.result;
  }

  async close(): Promise<void> {
    this.events.push("close");
  }
}

async function runCommand(client: FakeCapabilitiesClient) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: unknown[] = [];
  const exited = new Error("fake exit");
  const log = spyOn(console, "log").mockImplementation((line) => stdout.push(String(line)));
  const error = spyOn(console, "error").mockImplementation((line) => stderr.push(String(line)));
  const exit = spyOn(process, "exit").mockImplementation((code) => {
    exits.push(code);
    throw exited;
  });
  try {
    await runDaemonCommand(
      "capabilities",
      ["--json"],
      { clientFactory: () => client },
      SafeDaemonManager,
    ).catch((failure) => {
      if (failure !== exited) {
        throw failure;
      }
    });
  } finally {
    exit.mockRestore();
    error.mockRestore();
    log.mockRestore();
  }
  return { stdout, stderr, exits };
}

describe("daemon capabilities query", () => {
  test.each([
    { capabilities: ["input/gestureStream", "managed-slots/v1"] },
    {
      capabilities: ["input/gestureStream", "session-broker/v1"],
      pid: 4321,
      buildId: "daemon-build",
      entryScript: "/provider/dist/src/index.js",
    },
  ])("returns the daemon's full capability result", async (result) => {
    const client = new FakeCapabilitiesClient(result);
    expect(await queryExistingDaemonCapabilities(["--json"], () => client)).toBe(result);
    expect(client.events).toEqual([
      "connect",
      ["call", DAEMON_CAPABILITIES_METHOD, {}, { timeoutMs: DAEMON_CAPABILITIES_TIMEOUT_MS }],
      "close",
    ]);
  });

  test("the real command route prints the fake daemon result without other manager work", async () => {
    const result = { capabilities: ["session-broker/v1"] };
    const client = new FakeCapabilitiesClient(result);
    const output = await runCommand(client);
    expect(output).toEqual({ stdout: [JSON.stringify(result)], stderr: [], exits: [] });
    expect(client.events).toEqual([
      "connect",
      ["call", DAEMON_CAPABILITIES_METHOD, {}, { timeoutMs: DAEMON_CAPABILITIES_TIMEOUT_MS }],
      "close",
    ]);
  });

  test.each([
    {
      name: "stopped daemon",
      client: new FakeCapabilitiesClient(
        undefined,
        new DaemonUnavailableError("Daemon socket not found: fake.sock"),
      ),
      error: "Daemon socket not found: fake.sock",
      events: ["connect", "close"],
    },
    {
      name: "unreachable daemon",
      client: new FakeCapabilitiesClient(
        undefined,
        undefined,
        new DaemonUnavailableError("Daemon socket connection lost: connection closed"),
      ),
      error: "Daemon socket connection lost: connection closed",
      events: [
        "connect",
        ["call", DAEMON_CAPABILITIES_METHOD, {}, { timeoutMs: DAEMON_CAPABILITIES_TIMEOUT_MS }],
        "close",
      ],
    },
  ])("fails as JSON for a $name and closes the client", async ({ client, error, events }) => {
    const output = await runCommand(client);
    expect(output.stderr).toEqual([]);
    expect(output.exits).toEqual([1]);
    expect(output.stdout.map((line) => JSON.parse(line))).toEqual([{ ok: false, error }]);
    expect(client.events).toEqual(events);
  });

  test("rejects a malformed capability result", async () => {
    const client = new FakeCapabilitiesClient({ capabilities: ["session-broker/v1", 1] });
    const output = await runCommand(client);
    expect(output.stderr).toEqual([]);
    expect(output.exits).toEqual([1]);
    expect(output.stdout.map((line) => JSON.parse(line))).toEqual([
      { ok: false, error: "Invalid daemon capabilities result" },
    ]);
    expect(client.events.at(-1)).toBe("close");
  });

  test("preserves a daemon RPC refusal in the standard JSON envelope", async () => {
    const refusal = Object.assign(new Error("Capability query refused during shutdown"), {
      code: "daemon_shutting_down",
      nextAction: "Retry against the replacement daemon.",
      retryable: true,
      retryAfterMs: 250,
    });
    const client = new FakeCapabilitiesClient(undefined, undefined, refusal);
    const output = await runCommand(client);
    expect(output.stderr).toEqual([]);
    expect(output.exits).toEqual([1]);
    expect(output.stdout.map((line) => JSON.parse(line))).toEqual([
      {
        ok: false,
        error: "Capability query refused during shutdown",
        code: "daemon_shutting_down",
        nextAction: "Retry against the replacement daemon.",
        retryable: true,
        retryAfterMs: 250,
      },
    ]);
    expect(client.events.at(-1)).toBe("close");
  });
});

describe("daemon capabilities arguments", () => {
  test.each([
    { args: [], error: DAEMON_CAPABILITIES_COMMAND_USAGE },
    { args: ["--json=false"], error: DAEMON_CAPABILITIES_COMMAND_USAGE },
    { args: ["--json", "--json"], error: DAEMON_CAPABILITIES_COMMAND_USAGE },
    {
      args: ["--json", "extra"],
      error: "Unexpected argument for daemon capabilities: extra",
    },
    { args: ["--debug"], error: "Unknown option for daemon capabilities: --debug" },
  ])("requires exactly --json: $args", ({ args, error }) => {
    expect(daemonCommandArgumentError("capabilities", args)).toBe(error);
  });

  test("missing --json exits before creating a daemon client", async () => {
    let clientsCreated = 0;
    const exited = new Error("fake exit");
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const exit = spyOn(process, "exit").mockImplementation(() => {
      throw exited;
    });
    try {
      await expect(
        runDaemonCommand(
          "capabilities",
          [],
          {
            clientFactory: () => {
              clientsCreated++;
              return new FakeCapabilitiesClient({});
            },
          },
          SafeDaemonManager,
        ),
      ).rejects.toBe(exited);
      expect(clientsCreated).toBe(0);
    } finally {
      exit.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });
});
