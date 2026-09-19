import { describe, expect, test } from "bun:test";
import {
  applySession,
  buildMismatchHint,
  coerceValue,
  isSessionMintingTool,
  parseDriveArgs,
  runDrive,
  sessionUuidFromPayload,
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

describe("coerceValue", () => {
  test("parses JSON, falls back to string", () => {
    expect(coerceValue("0")).toBe(0);
    expect(coerceValue("true")).toBe(true);
    expect(coerceValue('{"text":"x"}')).toEqual({ text: "x" });
    expect(coerceValue("emulator-5554")).toBe("emulator-5554");
  });
});

describe("session helpers", () => {
  test("minting tools are recognized", () => {
    expect(isSessionMintingTool("getAndroid")).toBe(true);
    expect(isSessionMintingTool("tapOn")).toBe(false);
  });

  test("sessionUuidFromPayload reads a non-empty string only", () => {
    expect(sessionUuidFromPayload({ sessionUuid: "abc" })).toBe("abc");
    expect(sessionUuidFromPayload({ sessionUuid: "" })).toBeUndefined();
    expect(sessionUuidFromPayload({})).toBeUndefined();
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

  test("one-shot tool with coerced params", () => {
    const options = parseDriveArgs(
      ["tapOn", "--selector", '{"text":"Save"}', "--index", "0"],
      noPlan,
    );
    expect(options.steps).toHaveLength(1);
    expect(options.steps[0]).toEqual({
      tool: "tapOn",
      args: { selector: { text: "Save" }, index: 0 },
    });
  });

  test("flags, session, enable list", () => {
    const options = parseDriveArgs(
      ["observe", "--json", "--session", "s9", "--enable", "observe, tapOn ,inputText"],
      noPlan,
    );
    expect(options.json).toBe(true);
    expect(options.session).toBe("s9");
    expect(options.enable).toEqual(["observe", "tapOn", "inputText"]);
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
      getAndroid: envelope({ message: "ready", sessionUuid: "sess-1" }),
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
    const client = new FakeClient({ getAndroid: envelope({ message: "ready", sessionUuid: "s" }) });
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
