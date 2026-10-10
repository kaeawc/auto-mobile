import { describe, expect, test } from "bun:test";
import {
  applySession,
  buildMismatchHint,
  isSessionMintingTool,
  DEFAULT_DRIVE_TIMEOUT_MS,
  parseDriveArgs,
  privateEnvError,
  resolveTimeoutMs,
  runDrive,
  type DriveClient,
  type DriveStep,
} from "../../scripts/mcp-drive";

function envelope(payload: Record<string, unknown>, isError = false): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError,
  };
}

/** Records calls and replays canned envelopes keyed by tool name. */
class FakeClient implements DriveClient {
  calls: DriveStep[] = [];
  closed = false;
  constructor(private readonly replies: Record<string, unknown>) {}
  callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ tool: name, args });
    return Promise.resolve(this.replies[name] ?? envelope({ message: "ok" }));
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

describe("session helpers", () => {
  test("minting tools are recognized", () => {
    expect(isSessionMintingTool("getAndroid")).toBe(true);
    expect(isSessionMintingTool("tapOn")).toBe(false);
  });

  test("applySession injects for a normal tool but not a minting one or an explicit override", () => {
    expect(applySession({ tool: "tapOn", args: {} }, "s1").args.sessionUuid).toBe("s1");
    expect(applySession({ tool: "getAndroid", args: {} }, "s1").args.sessionUuid).toBeUndefined();
    expect(
      applySession({ tool: "tapOn", args: { sessionUuid: "keep" } }, "s1").args.sessionUuid,
    ).toBe("keep");
    expect(applySession({ tool: "tapOn", args: {} }, undefined).args.sessionUuid).toBeUndefined();
  });
});

describe("buildMismatchHint", () => {
  test("detects mismatch and stays silent otherwise", () => {
    expect(
      buildMismatchHint("AutoMobile daemon build mismatch: daemon build a != client b"),
    ).toContain("Restart the daemon");
    expect(buildMismatchHint("Device already assigned")).toBeUndefined();
    expect(buildMismatchHint(undefined)).toBeUndefined();
  });
});

describe("parseDriveArgs", () => {
  const noPlan = () => {
    throw new Error("no plan expected");
  };

  test("one-shot tool preserves numeric strings and coerces declared numbers", () => {
    const textOptions = parseDriveArgs(
      ["sendKeys", "--commands", '[{"action":"type","text":"12345"}]'],
      noPlan,
    );
    expect(textOptions.steps[0]).toEqual({
      tool: "sendKeys",
      args: { commands: [{ action: "type", text: "12345" }] },
    });

    const options = parseDriveArgs(["shake", "--duration", "0"], noPlan);
    expect(options.steps).toHaveLength(1);
    expect(options.steps[0]).toEqual({
      tool: "shake",
      args: { duration: 0 },
    });
  });

  test("flags, session, enable list", () => {
    const options = parseDriveArgs(
      ["observe", "--json", "--session", "s9", "--enable", "observe, tapOn ,sendKeys"],
      noPlan,
    );
    expect(options.json).toBe(true);
    expect(options.session).toBe("s9");
    expect(options.enable).toEqual(["observe", "tapOn", "sendKeys"]);
  });

  test("--plan reads a JSON array of steps", () => {
    const options = parseDriveArgs(["--plan", "p.json"], () =>
      JSON.stringify([
        { tool: "getAndroid", args: { deviceId: "emulator-5554" } },
        { tool: "observe" },
      ]),
    );
    expect(options.steps).toEqual([
      { tool: "getAndroid", args: { deviceId: "emulator-5554" } },
      { tool: "observe", args: {} },
    ]);
  });

  test("rejects tool + plan together and empty invocation", () => {
    expect(() => parseDriveArgs(["tapOn", "--plan", "p.json"], () => "[]")).toThrow();
    expect(() => parseDriveArgs([], noPlan)).toThrow();
  });
});

describe("runDrive", () => {
  const deps = (client: DriveClient) => ({
    createClient: () => Promise.resolve(client),
    defaultServerPath: () => "/tmp/dist/src/index.js",
    log: () => {},
  });

  test("captures a minted session and injects it into later calls", async () => {
    const client = new FakeClient({
      getAndroid: envelope({
        message: "ready",
        runtime: { session: { sessionUuid: "sess-1" } },
      }),
      observe: envelope({ message: "observed" }),
    });
    const result = await runDrive(
      {
        json: false,
        quiet: false,
        steps: [
          { tool: "getAndroid", args: { deviceId: "emulator-5554" } },
          { tool: "observe", args: {} },
        ],
      },
      deps(client),
    );
    expect(result.ok).toBe(true);
    expect(result.session).toBe("sess-1");
    expect(client.calls[0].args.sessionUuid).toBeUndefined(); // minting call untouched
    expect(client.calls[1].args.sessionUuid).toBe("sess-1"); // injected
    expect(client.closed).toBe(true);
  });

  test("merges --enable into the first minting call only", async () => {
    const client = new FakeClient({
      getAndroid: envelope({ message: "ready", runtime: { session: { sessionUuid: "s" } } }),
    });
    await runDrive(
      {
        json: false,
        quiet: false,
        enable: ["observe", "tapOn"],
        steps: [{ tool: "getAndroid", args: {} }],
      },
      deps(client),
    );
    expect(client.calls[0].args.enableTools).toEqual(["observe", "tapOn"]);
  });

  test("a tool error makes the run non-ok", async () => {
    const client = new FakeClient({ observe: envelope({ error: "boom" }, true) });
    const result = await runDrive(
      { json: false, quiet: false, steps: [{ tool: "observe", args: {} }] },
      deps(client),
    );
    expect(result.ok).toBe(false);
    expect(result.results[0].errorText).toBe("boom");
  });

  test("preserves plain-text transport errors", async () => {
    const transportError = {
      content: [{ type: "text", text: "MCP error -32603: Freshly started device is not ready" }],
      isError: true,
    };
    const client = new FakeClient({ observe: transportError });
    const result = await runDrive(
      { json: false, quiet: false, steps: [{ tool: "observe", args: {} }] },
      deps(client),
    );
    expect(result.results[0].errorText).toBe(
      "MCP error -32603: Freshly started device is not ready",
    );
    expect(result.results[0].errorText).not.toBe("tool reported isError");
  });

  test("JSON output renders failed tool envelopes", async () => {
    const logs: string[] = [];
    const failedEnvelope = envelope({ error: "boom", detail: "failed" }, true);
    const client = new FakeClient({ observe: failedEnvelope });
    await runDrive(
      { json: true, quiet: false, steps: [{ tool: "observe", args: {} }] },
      { ...deps(client), log: (message) => logs.push(message) },
    );
    const dumpedEnvelope = JSON.parse(logs[1]);
    expect(dumpedEnvelope).toEqual(failedEnvelope);
    expect(dumpedEnvelope.isError).toBe(true);
    expect(dumpedEnvelope.content).toEqual([
      { type: "text", text: '{"error":"boom","detail":"failed"}' },
    ]);
  });

  test("success:false makes the run non-ok without an error field", async () => {
    const client = new FakeClient({ observe: envelope({ success: false, message: "failed" }) });
    const result = await runDrive(
      { json: false, quiet: false, steps: [{ tool: "observe", args: {} }] },
      deps(client),
    );
    expect(result.ok).toBe(false);
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].errorText).toBe("failed");
  });

  test("default output renders payloads without a message", async () => {
    const logs: string[] = [];
    const client = new FakeClient({ observe: envelope({ hierarchy: { root: "screen" } }) });
    await runDrive(
      { json: false, quiet: false, steps: [{ tool: "observe", args: {} }] },
      { ...deps(client), log: (message) => logs.push(message) },
    );
    expect(logs).toContain('### observe: {"hierarchy":{"root":"screen"}}');
    expect(logs.join("\n")).not.toContain("(no message)");
  });

  test("a build mismatch stops the plan with a hint", async () => {
    const client = new FakeClient({
      getAndroid: envelope({ error: "AutoMobile daemon build mismatch: a != b" }, true),
      observe: envelope({ message: "should not run" }),
    });
    const result = await runDrive(
      {
        json: false,
        quiet: false,
        steps: [
          { tool: "getAndroid", args: {} },
          { tool: "observe", args: {} },
        ],
      },
      deps(client),
    );
    expect(result.ok).toBe(false);
    expect(result.results).toHaveLength(1); // stopped before observe
    expect(result.results[0].mismatchHint).toContain("Restart the daemon");
    expect(client.calls).toHaveLength(1);
  });
});

describe("timeout and --private", () => {
  test("flag beats env beats default", () => {
    expect(resolveTimeoutMs(5, { AUTOMOBILE_DRIVE_TIMEOUT_MS: "9" })).toBe(5);
    expect(resolveTimeoutMs(undefined, { AUTOMOBILE_DRIVE_TIMEOUT_MS: "9" })).toBe(9);
    expect(resolveTimeoutMs(undefined, {})).toBe(DEFAULT_DRIVE_TIMEOUT_MS);
    expect(DEFAULT_DRIVE_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  test("parses --timeout-ms and --private, rejecting bad values", () => {
    const options = parseDriveArgs(["--timeout-ms", "120000", "--private", "observe"], () => "");
    expect(options.timeoutMs).toBe(120000);
    expect(options.private).toBe(true);
    expect(() => parseDriveArgs(["observe", "--timeout-ms", "abc"], () => "")).toThrow();
    expect(() => parseDriveArgs(["observe", "--timeout-ms"], () => "")).toThrow();
  });

  test("privateEnvError requires an absolute aux socket dir", () => {
    expect(privateEnvError({})).toBeDefined();
    expect(privateEnvError({ AUTOMOBILE_AUX_SOCKET_DIR: "rel" })).toBeDefined();
    expect(privateEnvError({ AUTOMOBILE_AUX_SOCKET_DIR: "/tmp/lane" })).toBeUndefined();
  });

  test("runDrive refuses --private without env and never connects", async () => {
    let connected = false;
    const deps = {
      env: {},
      createClient: () => {
        connected = true;
        return Promise.resolve(new FakeClient({}));
      },
      defaultServerPath: () => "/x",
      log: () => {},
    };
    await expect(
      runDrive({ json: false, quiet: false, private: true, steps: [] }, deps),
    ).rejects.toThrow(/AUTOMOBILE_AUX_SOCKET_DIR/);
    expect(connected).toBe(false);
  });

  test("runDrive passes the resolved timeout to createClient", async () => {
    let seen = 0;
    await runDrive(
      { json: false, quiet: false, timeoutMs: 777, steps: [] },
      {
        createClient: (_p, timeoutMs) => {
          seen = timeoutMs;
          return Promise.resolve(new FakeClient({}));
        },
        defaultServerPath: () => "/x",
        log: () => {},
      },
    );
    expect(seen).toBe(777);
  });
});
