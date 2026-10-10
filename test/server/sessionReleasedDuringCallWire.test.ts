import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { SessionReleasedDuringCallError } from "../../src/daemon/sessionReleasedDuringCall";
import { executionTracker } from "../../src/server/executionTracker";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { McpTestFixture } from "../fixtures/mcpTestFixture";

/**
 * #11381: a call cancelled because its session was released under it is answered with the typed
 * terminal refusal by the real `tools/call` catch path, whatever the interrupted handler threw.
 * Driven through the real MCP server over an in-memory transport and the process execution
 * tracker, the way the daemon's release cancels a call.
 */
const PROBE_TOOL = "__released_during_call_probe__";
const SESSION = "released-under-the-call";

function wire(result: { content?: unknown }): Record<string, unknown> {
  const content = result.content as { text: string }[];
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe("a call cut by its session's release (#11381)", () => {
  let restoreHermeticServer: () => void;
  let fixture: McpTestFixture;
  let entered: PromiseWithResolvers<void>;
  let outcome: PromiseWithResolvers<never>;

  beforeAll(async () => {
    // Pay the server module's cold import and tool registration outside any test's budget.
    const restore = installHermeticServerFixture();
    const warm = new McpTestFixture();
    await warm.setup();
    await warm.teardown();
    restore();
  });

  beforeEach(async () => {
    restoreHermeticServer = installHermeticServerFixture();
    entered = Promise.withResolvers<void>();
    outcome = Promise.withResolvers<never>();
    ToolRegistry.register(PROBE_TOOL, "probe", z.object({}), () => {
      entered.resolve();
      return outcome.promise;
    });
    fixture = new McpTestFixture();
    await fixture.setup();
  });

  afterEach(async () => {
    await fixture.teardown();
    restoreHermeticServer();
  });

  /** Start the probe, cancel it the given way, then fail its handler like an aborted transport. */
  async function callCutBy(cancellation: string | Error) {
    const call = fixture.client.callTool({ name: PROBE_TOOL, arguments: {} });
    await entered.promise;
    expect(await executionTracker.cancelToolExecutions(PROBE_TOOL, cancellation)).toBe(1);
    outcome.reject(new Error("The operation was aborted"));
    return await call;
  }

  test("is answered session_ownership_lost with acquire_new_session", async () => {
    const result = await callCutBy(new SessionReleasedDuringCallError(SESSION, "cleanup-expired"));

    expect(result.isError).toBe(true);
    expect(wire(result)).toMatchObject({
      error: {
        code: "session_ownership_lost",
        sessionUuid: SESSION,
        reason: "cleanup-expired",
        retryable: false,
        nextAction: "acquire_new_session",
      },
    });
  });

  test("a cancellation that is not a session release keeps the handler's own failure", async () => {
    const result = await callCutBy("explicit-release");

    expect(result.isError).toBe(true);
    const content = result.content as { text: string }[];
    expect(content[0].text).toBe("Error: The operation was aborted");
  });
});
