import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { McpTimeoutError } from "../../src/daemon/wire/McpTimeoutError";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import type { DaemonRequest } from "../../src/daemon/types";
import { createTestUnixSocketServer } from "../helpers/createTestUnixSocketServer";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * #11814: every `input/*` route shares one preamble (clock, live-attempt check, remaining-budget
 * check) instead of six hand-written copies.
 */

interface Preamble {
  inputRouteClock(
    request: DaemonRequest,
    input: { receivedAtMs?: number } | undefined,
  ): { queueEnterMs: number; totalTimeoutMs: number };
  remainingInputBudgetMs(
    toolName: string,
    origin: string,
    queueEnterMs: number,
    totalTimeoutMs: number,
  ): number;
}

function fixture() {
  const timer = new FakeTimer();
  const server = createTestUnixSocketServer(
    "unused",
    { isInitialized: () => false } as DaemonStateAccess,
    timer,
  );
  // Typed callbacks exercise the real preamble helpers.
  const preamble: Preamble = {
    inputRouteClock: (request, input) => server.testHooks.input.inputRouteClock(request, input),
    remainingInputBudgetMs: (toolName, origin, queueEnterMs, totalTimeoutMs) =>
      server.testHooks.input.remainingInputBudgetMs(toolName, origin, queueEnterMs, totalTimeoutMs),
  };
  return { timer, preamble };
}

const INPUT_METHODS = [
  "input/tap",
  "input/swipe",
  "input/gestureStart",
  "input/gestureMove",
  "input/gestureEnd",
  "input/typeText",
  "input/pressButton",
  "input/key",
] as const;

describe("input/* request preamble (#11814)", () => {
  test.each([...INPUT_METHODS])(
    "%s: remaining budget is the total minus the queue wait",
    (method) => {
      const { timer, preamble } = fixture();
      timer.advanceTime(100);
      expect(preamble.remainingInputBudgetMs(method, "origin", 40, 1000)).toBe(940);
    },
  );

  test.each([...INPUT_METHODS])("%s: spent budget refuses with the queue-wait detail", (method) => {
    const { timer, preamble } = fixture();
    timer.advanceTime(1500);
    let caught: unknown;
    try {
      preamble.remainingInputBudgetMs(method, "UnixSocketServer.handleX", 500, 1000);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(McpTimeoutError);
    expect(caught).toMatchObject({
      message: expect.stringContaining("spent 1000ms waiting in queue"),
    });
  });

  test("the clock starts at receipt when the transport stamped one, else now", () => {
    const { timer, preamble } = fixture();
    timer.advanceTime(250);
    const request = { id: "1", type: "mcp_request", method: "input/tap" } as DaemonRequest;
    expect(preamble.inputRouteClock(request, { receivedAtMs: 100 }).queueEnterMs).toBe(100);
    expect(preamble.inputRouteClock(request, undefined).queueEnterMs).toBe(timer.now());
  });

  test("the budget check exists once in the socket server", () => {
    const source = readFileSync("src/daemon/socketServerParts/SocketInput.ts", "utf8");
    expect(source.match(/spent \$\{queueWaitMs\}ms waiting in queue/g)).toHaveLength(1);
  });
});
