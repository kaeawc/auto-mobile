import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { IOSCtrlProxy } from "../../src/features/observe/ios/IOSCtrlProxyClient";
import type { WebSocketMessage } from "../../src/features/observe/ios/types";

/**
 * Behavioural contract for the iOS CtrlProxy gesture and key surface, run against the real
 * `IOSCtrlProxyClient` (over a replayed socket) and `FakeIOSCtrlProxy`. Every runner reply comes from
 * `test/fixtures/ios-contract/runner-responses.json`, which the Swift runner's production encoders
 * wrote (`ResponseContractFixtureTests`); nothing here hand-writes wire output.
 *
 * The contract compares what a caller can observe: whether the call succeeded, the runner's error
 * text, whether the request counts as dispatched and acknowledged, and the request (type and
 * arguments) that reached the runner. It deliberately ignores values the runner measures itself
 * (`totalTimeMs`, `perfTiming`, `tapDiagnostics`, `gestureTimeMs`): a fake has no clock to match.
 */
const RESPONSES = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dir, "../fixtures/ios-contract/runner-responses.json"),
    "utf8",
  ),
) as { responses: { name: string; wire: WebSocketMessage }[] };

/** A captured runner reply by its fixture name. */
export function capturedResponse(name: string): WebSocketMessage {
  const found = RESPONSES.responses.find((response) => response.name === name);
  if (!found) {
    throw new Error(`No captured runner response named ${name}`);
  }
  return found.wire;
}

/** A request as the runner received it, reduced to its type and meaningful arguments. */
export interface ContractRequest {
  type: string;
  [argument: string]: unknown;
}

export interface IosCtrlProxyHarness {
  proxy: IOSCtrlProxy;
  /** Requests that reached the runner (real: sent frames; fake: its call histories), in order. */
  requests(): ContractRequest[];
  close(): Promise<void>;
}

/** The runner replies to serve, keyed by request type. */
export type IosCtrlProxyReplies = Record<string, WebSocketMessage>;

export type IosCtrlProxyHarnessFactory = (
  replies: IosCtrlProxyReplies,
) => Promise<IosCtrlProxyHarness>;

interface Observed {
  success: boolean;
  error?: string;
  dispatched?: boolean;
  acknowledged?: boolean;
}

function observed(result: {
  success: boolean;
  error?: string;
  dispatched?: boolean;
  acknowledged?: boolean;
}): Observed {
  return {
    success: result.success,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.dispatched !== undefined ? { dispatched: result.dispatched } : {}),
    ...(result.acknowledged !== undefined ? { acknowledged: result.acknowledged } : {}),
  };
}

interface Scenario {
  name: string;
  /** Captured replies this scenario needs, by request type. */
  replies: IosCtrlProxyReplies;
  run(proxy: IOSCtrlProxy): Promise<Observed[]>;
  expectedRequests: ContractRequest[];
  expected: Observed[];
}

const ack = { dispatched: true, acknowledged: true } as const;

const SCENARIOS: Scenario[] = [
  {
    name: "a tap is sent with its coordinates and duration and counts as dispatched and acknowledged",
    replies: { request_tap_coordinates: capturedResponse("tap_coordinates_result") },
    run: async (proxy) => [observed(await proxy.requestTapCoordinates(201, 406, 100))],
    expectedRequests: [{ type: "request_tap_coordinates", x: 201, y: 406, duration: 100 }],
    expected: [{ success: true, ...ack }],
  },
  {
    name: "a swipe is sent with both endpoints and its duration",
    replies: { request_swipe: capturedResponse("swipe_result") },
    run: async (proxy) => [observed(await proxy.requestSwipe(10, 20, 30, 40, 300))],
    expectedRequests: [{ type: "request_swipe", x1: 10, y1: 20, x2: 30, y2: 40, duration: 300 }],
    expected: [{ success: true, ...ack }],
  },
  {
    name: "press home sends no arguments and counts as dispatched and acknowledged",
    replies: { request_press_home: capturedResponse("press_home_result") },
    run: async (proxy) => [observed(await proxy.requestPressHome())],
    expectedRequests: [{ type: "request_press_home" }],
    expected: [{ success: true, ...ack }],
  },
  {
    name: "press back sends no arguments and counts as dispatched and acknowledged",
    replies: { request_press_back: capturedResponse("press_back_result") },
    run: async (proxy) => [observed(await proxy.requestPressBack())],
    expectedRequests: [{ type: "request_press_back" }],
    expected: [{ success: true, ...ack }],
  },
  {
    name: "a key press is sent with its key and modifiers",
    replies: { request_press_key: capturedResponse("press_key_result") },
    run: async (proxy) => [observed(await proxy.requestPressKey("tab", ["shift"]))],
    expectedRequests: [{ type: "request_press_key", key: "tab", modifiers: ["shift"] }],
    expected: [{ success: true, ...ack }],
  },
  {
    name: "a runner refusal comes back as a failed result carrying the runner's message, not a throw",
    replies: { request_press_key: capturedResponse("error_execution_failed") },
    run: async (proxy) => [observed(await proxy.requestPressKey("enter", []))],
    expectedRequests: [{ type: "request_press_key", key: "enter", modifiers: [] }],
    expected: [{ success: false, error: "Command execution failed: fixture reason", ...ack }],
  },
  {
    name: "requests reach the runner in call order",
    replies: {
      request_tap_coordinates: capturedResponse("tap_coordinates_result"),
      request_press_home: capturedResponse("press_home_result"),
      request_swipe: capturedResponse("swipe_result"),
    },
    run: async (proxy) => [
      observed(await proxy.requestTapCoordinates(1, 2, 50)),
      observed(await proxy.requestPressHome()),
      observed(await proxy.requestSwipe(5, 6, 7, 8, 120)),
    ],
    expectedRequests: [
      { type: "request_tap_coordinates", x: 1, y: 2, duration: 50 },
      { type: "request_press_home" },
      { type: "request_swipe", x1: 5, y1: 6, x2: 7, y2: 8, duration: 120 },
    ],
    expected: [
      { success: true, ...ack },
      { success: true, ...ack },
      { success: true, ...ack },
    ],
  },
];

export function runIOSCtrlProxyContract(name: string, factory: IosCtrlProxyHarnessFactory): void {
  describe(`IOSCtrlProxy contract: ${name}`, () => {
    for (const scenario of SCENARIOS) {
      test(scenario.name, async () => {
        const harness = await factory(scenario.replies);
        try {
          expect(await scenario.run(harness.proxy)).toEqual(scenario.expected);
          expect(harness.requests()).toEqual(scenario.expectedRequests);
        } finally {
          await harness.close();
        }
      });
    }
  });
}
