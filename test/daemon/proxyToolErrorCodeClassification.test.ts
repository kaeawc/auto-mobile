import { McpError, ErrorCode } from "../../src/daemon/mcpError";
import { describe, expect, test } from "bun:test";
import { daemonResponseError } from "../../src/daemon/client/client";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { mcpRequestFailureDetails } from "../../src/daemon/socketServer";
import {
  DAEMON_SESSION_NOT_ACTIVE_CODE,
  DAEMON_TOOL_UNAVAILABLE_CODE,
  DAEMON_UNKNOWN_TOOL_CODE,
  type DaemonResponse,
} from "../../src/daemon/types";
import { UnissuedSessionError } from "../../src/daemon/sessionManager";
import { ToolUnavailableError, UnknownToolError } from "../../src/daemon/toolUnavailableError";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";

/**
 * #11821: the proxy classifies unknown-tool and not-an-active-session refusals by the structured
 * code the daemon sends. Message prose is consulted only for a daemon that predates the codes
 * (no `structuredToolErrorCodes` capability), and the verdicts for every previously
 * message-matched case must be unchanged.
 */

interface Classifier {
  structuredToolErrorCodes: boolean;
  isPreDispatchDaemonSessionError(error: unknown): boolean;
  isUnknownToolError(error: unknown): boolean;
  isRecoverableUnknownToolError(error: unknown): boolean;
  isRecoverableDaemonSessionError(error: unknown): boolean;
  frontendRegistersTool(name: string): boolean;
}

function makeProxy(structured: boolean): Classifier {
  const proxy = new DaemonMcpProxy({
    clientFactory: () => {
      throw new Error("not used");
    },
    daemonManager: new FakeDaemonManager(),
    autoStartDaemon: false,
  });
  // Bracket access reaches the private classification seams without a type-erasing cast.
  proxy.getInternalsForTesting().structuredToolErrorCodes = structured;
  return {
    structuredToolErrorCodes: structured,
    isPreDispatchDaemonSessionError: (error) =>
      proxy.getInternalsForTesting().errorClassifier.isPreDispatchDaemonSessionError(error),
    isUnknownToolError: (error) =>
      proxy.getInternalsForTesting().errorClassifier.isUnknownToolError(error),
    isRecoverableUnknownToolError: (error) =>
      proxy.getInternalsForTesting().errorClassifier.isRecoverableUnknownToolError(error),
    isRecoverableDaemonSessionError: (error) =>
      proxy.getInternalsForTesting().errorClassifier.isRecoverableDaemonSessionError(error),
    frontendRegistersTool: (name) => proxy.getInternalsForTesting().frontendRegistersTool(name),
  };
}

/** What the daemon puts on the wire for `error`, rebuilt into the error the proxy sees. */
function acrossTheWire(error: Error): Error {
  const failure = mcpRequestFailureDetails(error, undefined);
  const response: DaemonResponse = {
    id: "1",
    type: "mcp_response",
    success: false,
    error: error.message,
    ...failure,
  };
  return daemonResponseError(response);
}

const REGISTERED = "observe";
const UNREGISTERED = "inputText";
const hint = "inputText was removed; use sendKeys";

interface Case {
  label: string;
  /** The error a pre-code daemon sent: prose only. */
  legacy: Error;
  /** The error the current daemon sends for the same refusal. */
  coded: Error;
  preDispatch: boolean;
  unknownTool: boolean;
  recoverableUnknownTool: boolean;
  recoverableSession: boolean;
}

const cases: Case[] = [
  {
    label: "unknown tool the frontend registers",
    legacy: new Error(`MCP error -32603: Unknown tool: ${REGISTERED}`),
    coded: acrossTheWire(new UnknownToolError(REGISTERED)),
    preDispatch: true,
    unknownTool: true,
    recoverableUnknownTool: true,
    recoverableSession: true,
  },
  {
    label: "unknown tool the frontend does not register",
    legacy: new Error(`MCP error -32603: Unknown tool: ${UNREGISTERED}. ${hint}`),
    coded: acrossTheWire(new UnknownToolError(UNREGISTERED, hint)),
    preDispatch: true,
    unknownTool: true,
    recoverableUnknownTool: false,
    recoverableSession: false,
  },
  {
    label: "session the daemon never issued",
    legacy: new Error("Session s1 is not an active daemon session (not found). Acquire a device."),
    coded: acrossTheWire(
      new UnissuedSessionError("Session s1 is not an active daemon session (not found)."),
    ),
    preDispatch: true,
    unknownTool: false,
    recoverableUnknownTool: false,
    recoverableSession: false,
  },
  {
    label: "unrelated failure",
    legacy: new Error("boom"),
    coded: acrossTheWire(new Error("boom")),
    preDispatch: false,
    unknownTool: false,
    recoverableUnknownTool: false,
    recoverableSession: false,
  },
];

describe("proxy classifies tool refusals by code (#11821)", () => {
  test.each(cases)("$label: legacy prose and structured code agree", (scenario) => {
    for (const [structured, error] of [
      [false, scenario.legacy],
      [true, scenario.coded],
    ] as const) {
      const proxy = makeProxy(structured);
      expect(proxy.isPreDispatchDaemonSessionError(error)).toBe(scenario.preDispatch);
      expect(proxy.isUnknownToolError(error)).toBe(scenario.unknownTool);
      expect(proxy.isRecoverableUnknownToolError(error)).toBe(scenario.recoverableUnknownTool);
      expect(proxy.isRecoverableDaemonSessionError(error)).toBe(scenario.recoverableSession);
    }
  });

  test("the daemon marks each refusal with its code on the wire", () => {
    const unknown = mcpRequestFailureDetails(new UnknownToolError("foo"), undefined);
    expect(unknown).toMatchObject({ code: DAEMON_UNKNOWN_TOOL_CODE, details: { toolName: "foo" } });
    const notActive = mcpRequestFailureDetails(new UnissuedSessionError("x"), undefined);
    expect(notActive.code).toBe(DAEMON_SESSION_NOT_ACTIVE_CODE);
    // The SDK client rebuilds these as an McpError carrying the same `data`.
    const rebuilt = new McpError(ErrorCode.InternalError, "m", { code: DAEMON_UNKNOWN_TOOL_CODE });
    expect(mcpRequestFailureDetails(rebuilt, undefined).code).toBe(DAEMON_UNKNOWN_TOOL_CODE);
  });

  test("a gated tool keeps its own code and is not an unknown tool", () => {
    const gated = acrossTheWire(new ToolUnavailableError("setPreference", ["--debug disabled"]));
    expect((gated as Error & { code?: string }).code).toBe(DAEMON_TOOL_UNAVAILABLE_CODE);
    const proxy = makeProxy(true);
    expect(proxy.isRecoverableUnknownToolError(gated)).toBe(false);
    expect(proxy.isPreDispatchDaemonSessionError(gated)).toBe(true);
  });

  test("a daemon with structured codes is never classified from prose", () => {
    const proxy = makeProxy(true);
    for (const prose of [
      `MCP error -32603: Unknown tool: ${REGISTERED}`,
      "Session s1 is not an active daemon session (not found).",
    ]) {
      const error = new Error(prose);
      expect(proxy.isPreDispatchDaemonSessionError(error)).toBe(false);
      expect(proxy.isRecoverableUnknownToolError(error)).toBe(false);
    }
  });
});
