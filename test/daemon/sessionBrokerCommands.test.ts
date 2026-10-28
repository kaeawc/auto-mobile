import { describe, expect, spyOn, test, afterEach, mock } from "bun:test";
import type { DaemonMethodCallOptions } from "../../src/daemon/client/client";
import {
  daemonCommandArgumentError,
  runDaemonCommand,
} from "../../src/daemon/cli/runDaemonCommand";
import {
  abandonBrokerSessionRequest,
  parseSessionBrokerCommandArgs,
  queryBrokerSessionRequestStatus,
  releaseBrokerSession,
  SESSION_BROKER_RELEASE_TIMEOUT_MS,
  SESSION_BROKER_STATUS_TIMEOUT_MS,
  type SessionBrokerCommandClient,
} from "../../src/daemon/cli/sessionBrokerCommands";
import {
  DAEMON_ABANDON_SESSION_REQUEST_METHOD,
  DAEMON_RELEASE_BROKER_SESSION_METHOD,
  DAEMON_SESSION_REQUEST_STATUS_METHOD,
} from "../../src/daemon/sessionBrokerProxyAcquisition";
import { SESSION_BROKER_RETRY_AFTER_MS } from "../../src/daemon/sessionBroker/SessionRequestOwnerMismatchError";
import { describeUnknownError } from "../../src/utils/describeUnknownError";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";

afterEach(() => mock.restore());

const REQUEST_ID = "python-harness-attempt-1";
const SESSION_UUID = "f4e8bd2a-991c-4c97-a530-b4d687a54475";
const OWNER_TOKEN = "owner-token-that-must-stay-private";

class FakeBrokerCommandClient implements SessionBrokerCommandClient {
  readonly calls: Array<{
    method: string;
    params: Record<string, unknown>;
    options: DaemonMethodCallOptions;
  }> = [];
  connectCalls = 0;
  closeCalls = 0;

  constructor(
    private readonly result: unknown,
    private readonly failure?: Error,
  ) {}

  async connect(): Promise<void> {
    this.connectCalls++;
  }

  async callDaemonMethod(
    method: string,
    params: Record<string, unknown>,
    options: DaemonMethodCallOptions,
  ): Promise<unknown> {
    this.calls.push({ method, params, options });
    if (this.failure) {
      throw this.failure;
    }
    return this.result;
  }

  async close(): Promise<void> {
    this.closeCalls++;
  }

  async callTool(): Promise<never> {
    throw new Error("A broker command must not call an MCP tool");
  }

  async readResource(): Promise<never> {
    throw new Error("A broker command must not read an MCP resource");
  }
}

const statusArgs = [REQUEST_ID, "--liveness-owner-token", OWNER_TOKEN, "--json"];
const abandonArgs = [REQUEST_ID, "--liveness-owner-token", OWNER_TOKEN, "--json"];
const releaseArgs = [SESSION_UUID, "--liveness-owner-token", OWNER_TOKEN, "--json"];

describe("session broker command arguments", () => {
  test("accepts either normal flag form and retains the explicit identity", () => {
    expect(parseSessionBrokerCommandArgs("session-request-status", statusArgs)).toEqual({
      identity: REQUEST_ID,
      livenessOwnerToken: OWNER_TOKEN,
    });
    expect(parseSessionBrokerCommandArgs("abandon-session-request", abandonArgs)).toEqual({
      identity: REQUEST_ID,
      livenessOwnerToken: OWNER_TOKEN,
    });
    expect(
      parseSessionBrokerCommandArgs("release-broker-session", [
        "--json=true",
        SESSION_UUID,
        `--liveness-owner-token=${OWNER_TOKEN}`,
      ]),
    ).toEqual({ identity: SESSION_UUID, livenessOwnerToken: OWNER_TOKEN });
  });

  test("release rejects a non-UUID identity before creating a daemon client", async () => {
    const args = ["not-a-uuid", "--liveness-owner-token", OWNER_TOKEN, "--json"];
    expect(daemonCommandArgumentError("release-broker-session", args)).toContain(
      "Usage: release-broker-session <session-uuid>",
    );
    let clientsCreated = 0;
    await expect(
      releaseBrokerSession(args, () => {
        clientsCreated++;
        return new FakeBrokerCommandClient({});
      }),
    ).rejects.toThrow("Usage: release-broker-session <session-uuid>");
    expect(clientsCreated).toBe(0);
  });

  test.each<{ name: string; args: string[] }>([
    { name: "no arguments", args: [] },
    { name: "missing identity and token", args: [REQUEST_ID, "--json"] },
    {
      name: "blank token",
      args: [REQUEST_ID, "--liveness-owner-token", " ", "--json"],
    },
    {
      name: "missing json",
      args: [REQUEST_ID, "--liveness-owner-token", OWNER_TOKEN],
    },
    {
      name: "disabled json",
      args: [REQUEST_ID, "--liveness-owner-token", OWNER_TOKEN, "--json=false"],
    },
    {
      name: "extra argument",
      args: [REQUEST_ID, "--liveness-owner-token", OWNER_TOKEN, "--json", "extra"],
    },
    {
      name: "duplicate token",
      args: [
        REQUEST_ID,
        "--liveness-owner-token",
        OWNER_TOKEN,
        "--liveness-owner-token",
        "other",
        "--json",
      ],
    },
  ])("rejects $name without echoing values", ({ args }) => {
    const error = daemonCommandArgumentError("session-request-status", args);
    expect(error).toContain(
      "Usage: session-request-status <request-id> --liveness-owner-token <token> --json",
    );
    expect(error).not.toContain(OWNER_TOKEN);
  });
});

describe("session broker status command", () => {
  test("v1 status accepts additive timing and unknown fields without stripping them", async () => {
    const receipt = {
      contractVersion: 1,
      requestId: REQUEST_ID,
      outcome: "pending",
      sessionUuid: null,
      profile: null,
      cleanupPending: true,
      timing: {
        reset: {
          mode: "erase",
          outcome: "pending",
          phases: { stop: 3 },
          reuseCount: 1,
          startedAtMs: 0,
          totalMs: 3,
        },
      },
      futureField: "ignored",
    } as const;
    const client = new FakeBrokerCommandClient(receipt);
    expect(await queryBrokerSessionRequestStatus(statusArgs, () => client)).toBe(receipt);
  });
  test.each([
    {
      contractVersion: 1,
      requestId: REQUEST_ID,
      outcome: "pending",
      sessionUuid: null,
      profile: null,
      cleanupPending: true,
    },
    {
      contractVersion: 1,
      requestId: REQUEST_ID,
      outcome: "failed",
      sessionUuid: null,
      profile: null,
      cleanupPending: false,
      failure: { code: "catalog_failed", message: "No matching runtime", retryable: false },
    },
  ])("returns the durable $outcome receipt as a successful query", async (receipt) => {
    const client = new FakeBrokerCommandClient(receipt);
    expect(await queryBrokerSessionRequestStatus(statusArgs, () => client)).toBe(receipt);
    expect(client.calls).toEqual([
      {
        method: DAEMON_SESSION_REQUEST_STATUS_METHOD,
        params: { requestId: REQUEST_ID, livenessOwnerToken: OWNER_TOKEN },
        options: { timeoutMs: SESSION_BROKER_STATUS_TIMEOUT_MS },
      },
    ]);
    expect(client.closeCalls).toBe(1);
  });

  test("rejects a mismatched status identity and still closes the client", async () => {
    const client = new FakeBrokerCommandClient({
      contractVersion: 1,
      requestId: "different-request",
      outcome: "pending",
      sessionUuid: null,
      profile: null,
      cleanupPending: true,
    });
    await expect(queryBrokerSessionRequestStatus(statusArgs, () => client)).rejects.toThrow(
      "Invalid daemon session-request-status result",
    );
    expect(client.closeCalls).toBe(1);
  });
});

describe("session broker release command", () => {
  test("release accepts additive reset timing without stripping it", async () => {
    const receipt = {
      sessionUuid: SESSION_UUID,
      outcome: "released",
      timing: {
        reset: {
          mode: "erase",
          outcome: "clean",
          phases: { erase: 5 },
          reuseCount: 1,
          startedAtMs: 0,
          totalMs: 5,
        },
      },
    } as const;
    const client = new FakeBrokerCommandClient(receipt);
    expect(await releaseBrokerSession(releaseArgs, () => client)).toBe(receipt);
  });
  test("keeps unknown_session explicit and uses the 240-second release timeout budget", async () => {
    const receipt = { sessionUuid: SESSION_UUID, outcome: "unknown_session" as const };
    const client = new FakeBrokerCommandClient(receipt);
    expect(await releaseBrokerSession(releaseArgs, () => client)).toBe(receipt);
    expect(client.calls).toEqual([
      {
        method: DAEMON_RELEASE_BROKER_SESSION_METHOD,
        params: { sessionId: SESSION_UUID, livenessOwnerToken: OWNER_TOKEN },
        options: { timeoutMs: SESSION_BROKER_RELEASE_TIMEOUT_MS },
      },
    ]);
    expect(client.closeCalls).toBe(1);
  });

  test("returns cleanup_pending without retrying or claiming cleanup is complete", async () => {
    const receipt = { sessionUuid: SESSION_UUID, outcome: "cleanup_pending" as const };
    const client = new FakeBrokerCommandClient(receipt);
    expect(await releaseBrokerSession(releaseArgs, () => client)).toEqual(receipt);
    expect(client.calls).toHaveLength(1);
    expect(client.closeCalls).toBe(1);
  });

  test("closes after a failed call and redacts the owner token from JSON diagnostics", async () => {
    const client = new FakeBrokerCommandClient(
      undefined,
      Object.assign(new Error(`Owner ${OWNER_TOKEN} was refused`), {
        code: "session_owner_conflict",
      }),
    );
    const stdout: string[] = [];
    const exited = new Error("fake exit");
    const log = spyOn(console, "log").mockImplementation((line) => stdout.push(String(line)));
    const exit = spyOn(process, "exit").mockImplementation(() => {
      throw exited;
    });
    try {
      await expect(
        runDaemonCommand(
          "release-broker-session",
          releaseArgs,
          { clientFactory: () => client },
          SafeDaemonManager,
        ),
      ).rejects.toBe(exited);
      expect(stdout.join("\n")).not.toContain(OWNER_TOKEN);
      expect(JSON.parse(stdout[0])).toEqual({
        ok: false,
        error: "Owner [REDACTED] was refused",
        code: "session_owner_conflict",
      });
      expect(client.closeCalls).toBe(1);
    } finally {
      exit.mockRestore();
      log.mockRestore();
    }
  });

  test("a sanitized failure retains no raw cause for downstream logging", async () => {
    const client = new FakeBrokerCommandClient(
      undefined,
      new Error(`Transport failed for ${OWNER_TOKEN}`),
    );
    const failure = await releaseBrokerSession(releaseArgs, () => client).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(describeUnknownError(failure)).not.toContain(OWNER_TOKEN);
    expect(failure instanceof Error ? failure.cause : "not an error").toBeUndefined();
    expect(client.closeCalls).toBe(1);
  });

  test("the wired command prints unknown_session without confirming a release", async () => {
    const receipt = { sessionUuid: SESSION_UUID, outcome: "unknown_session" as const };
    const client = new FakeBrokerCommandClient(receipt);
    const stdout: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line) => stdout.push(String(line)));
    try {
      await runDaemonCommand(
        "release-broker-session",
        releaseArgs,
        { clientFactory: () => client },
        SafeDaemonManager,
      );
      expect(stdout).toEqual([JSON.stringify(receipt)]);
    } finally {
      log.mockRestore();
    }
  });
});

describe("session broker abandon command", () => {
  test("returns the terminal receipt and uses the cleanup-capable timeout", async () => {
    const receipt = {
      contractVersion: 1,
      requestId: REQUEST_ID,
      outcome: "failed",
      sessionUuid: null,
      profile: null,
      cleanupPending: false,
      failure: {
        code: "session_request_abandoned",
        message: "Session request was abandoned by its liveness owner",
        retryable: false,
      },
    } as const;
    const client = new FakeBrokerCommandClient(receipt);
    expect(await abandonBrokerSessionRequest(abandonArgs, () => client)).toBe(receipt);
    expect(client.calls).toEqual([
      {
        method: DAEMON_ABANDON_SESSION_REQUEST_METHOD,
        params: { requestId: REQUEST_ID, livenessOwnerToken: OWNER_TOKEN },
        options: { timeoutMs: SESSION_BROKER_RELEASE_TIMEOUT_MS },
      },
    ]);
    expect(client.closeCalls).toBe(1);
  });
});

describe("session broker refusal CLI forwarding", () => {
  for (const command of ["release-broker-session", "abandon-session-request"] as const) {
    test.each([
      {
        code: "session_restart_handoff_pending",
        retryable: true,
        retryAfterMs: SESSION_BROKER_RETRY_AFTER_MS,
      },
      { code: "session_owner_mismatch", retryable: false },
      { code: "session_broker_unavailable", retryable: false },
      {
        code: "session_broker_unavailable",
        retryable: true,
        retryAfterMs: SESSION_BROKER_RETRY_AFTER_MS,
      },
    ])(`${command} preserves $code retry hints in JSON`, async (fields) => {
      const client = new FakeBrokerCommandClient(
        undefined,
        Object.assign(new Error(`Refused owner ${OWNER_TOKEN}`), fields),
      );
      const stdout: string[] = [];
      const exited = new Error("fake exit");
      const log = spyOn(console, "log").mockImplementation((line) => stdout.push(String(line)));
      const exit = spyOn(process, "exit").mockImplementation(() => {
        throw exited;
      });
      try {
        await expect(
          runDaemonCommand(
            command,
            command === "release-broker-session" ? releaseArgs : abandonArgs,
            { clientFactory: () => client },
            SafeDaemonManager,
          ),
        ).rejects.toBe(exited);
        expect(JSON.parse(stdout[0])).toEqual({
          ok: false,
          error: "Refused owner [REDACTED]",
          ...fields,
        });
        expect(client.closeCalls).toBe(1);
      } finally {
        exit.mockRestore();
        log.mockRestore();
      }
    });
  }
});
