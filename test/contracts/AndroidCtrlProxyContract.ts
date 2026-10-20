import type { TapCoordinatesRequest } from "../../src/features/observe/shared/SharedGestureDelegate";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { DragRequest } from "../../src/utils/interfaces/DragRequest";
import type { SwipeRequest } from "../../src/utils/interfaces/SwipeRequest";

/**
 * Behavioural contract for the Android CtrlProxy gesture surface, run against the real
 * `AndroidCtrlProxyClient` (over a replayed socket) and `FakeCtrlProxy`. Every device reply comes
 * from `test/fixtures/android-contract/android-responses.json`, which the Kotlin `:protocol`
 * module's production encoders wrote (`ResponseContractFixtureTest`); nothing here hand-writes
 * wire output.
 *
 * The contract compares what a caller can observe: whether the call succeeded, the device's error
 * text, and the request (type and arguments) that reached the device. It deliberately ignores
 * values the device measures itself (`totalTimeMs`, `gestureTimeMs`, `perfTiming`): a fake has no
 * clock to match.
 */
export interface WireReply {
  type: string;
  [field: string]: unknown;
}

const RESPONSES = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dir, "../fixtures/android-contract/android-responses.json"),
    "utf8",
  ),
) as { responses: { name: string; wire: WireReply }[] };

/** A captured device reply by its fixture name. */
export function capturedResponse(name: string): WireReply {
  const found = RESPONSES.responses.find((response) => response.name === name);
  if (!found) {
    throw new Error(`No captured device response named ${name}`);
  }
  return found.wire;
}

/** A request as the device received it, reduced to its type and meaningful arguments. */
export interface ContractRequest {
  type: string;
  [argument: string]: unknown;
}

/** The gesture surface both implementations must agree on. */
export interface AndroidGestureSurface {
  requestTapCoordinates(request: TapCoordinatesRequest): Promise<ContractResult>;
  requestSwipe(
    request: Pick<SwipeRequest, "x1" | "y1" | "x2" | "y2" | "duration">,
  ): Promise<ContractResult>;
  requestDrag(request: DragRequest): Promise<ContractResult>;
}

interface ContractResult {
  success: boolean;
  error?: string;
}

export interface AndroidCtrlProxyHarness {
  proxy: AndroidGestureSurface;
  /** Requests that reached the device (real: sent frames; fake: its call histories), in order. */
  requests(): ContractRequest[];
  close(): Promise<void>;
}

/** The device replies to serve, keyed by request type. */
export type AndroidCtrlProxyReplies = Record<string, WireReply>;

export type AndroidCtrlProxyHarnessFactory = (
  replies: AndroidCtrlProxyReplies,
) => Promise<AndroidCtrlProxyHarness>;

interface Observed {
  success: boolean;
  error?: string;
}

function observed(result: ContractResult): Observed {
  return {
    success: result.success,
    ...(result.error !== undefined && result.error !== null ? { error: result.error } : {}),
  };
}

interface Scenario {
  name: string;
  /** Captured replies this scenario needs, by request type. */
  replies: AndroidCtrlProxyReplies;
  run(proxy: AndroidGestureSurface): Promise<Observed[]>;
  expectedRequests: ContractRequest[];
  expected: Observed[];
}

const SCENARIOS: Scenario[] = [
  {
    name: "a tap is sent with its coordinates and duration and succeeds",
    replies: { request_tap_coordinates: capturedResponse("tap_coordinates_result") },
    run: async (proxy) => [
      observed(await proxy.requestTapCoordinates({ x: 201, y: 406, duration: 100 })),
    ],
    expectedRequests: [{ type: "request_tap_coordinates", x: 201, y: 406, duration: 100 }],
    expected: [{ success: true }],
  },
  {
    name: "a tap without a duration presses for 10 ms",
    replies: { request_tap_coordinates: capturedResponse("tap_coordinates_result") },
    run: async (proxy) => [observed(await proxy.requestTapCoordinates({ x: 5, y: 6 }))],
    expectedRequests: [{ type: "request_tap_coordinates", x: 5, y: 6, duration: 10 }],
    expected: [{ success: true }],
  },
  {
    name: "a refused tap comes back as a failed result carrying the device's message, not a throw",
    replies: { request_tap_coordinates: capturedResponse("tap_coordinates_refused") },
    run: async (proxy) => [
      observed(await proxy.requestTapCoordinates({ x: 1, y: 2, duration: 10 })),
    ],
    expectedRequests: [{ type: "request_tap_coordinates", x: 1, y: 2, duration: 10 }],
    expected: [{ success: false, error: "Gesture dispatch was cancelled" }],
  },
  {
    name: "a swipe is sent with both endpoints and its duration",
    replies: { request_swipe: capturedResponse("swipe_result") },
    run: async (proxy) => [
      observed(await proxy.requestSwipe({ x1: 10, y1: 20, x2: 30, y2: 40, duration: 300 })),
    ],
    expectedRequests: [{ type: "request_swipe", x1: 10, y1: 20, x2: 30, y2: 40, duration: 300 }],
    expected: [{ success: true }],
  },
  {
    name: "a refused swipe comes back as a failed result carrying the device's message",
    replies: { request_swipe: capturedResponse("swipe_refused") },
    run: async (proxy) => [
      observed(await proxy.requestSwipe({ x1: 10, y1: 20, x2: 30, y2: 40, duration: 300 })),
    ],
    expectedRequests: [{ type: "request_swipe", x1: 10, y1: 20, x2: 30, y2: 40, duration: 300 }],
    expected: [{ success: false, error: "Gesture dispatch was cancelled" }],
  },
  {
    name: "a protocol error envelope fails the call with the device's message",
    replies: { request_swipe: capturedResponse("error_decode_failed") },
    run: async (proxy) => [
      observed(await proxy.requestSwipe({ x1: 1, y1: 2, x2: 3, y2: 4, duration: 100 })),
    ],
    expectedRequests: [{ type: "request_swipe", x1: 1, y1: 2, x2: 3, y2: 4, duration: 100 }],
    expected: [{ success: false, error: "Failed to decode request_swipe: missing field x2" }],
  },
  {
    name: "a drag is sent with its endpoints and three phase durations",
    replies: { request_drag: capturedResponse("drag_result") },
    run: async (proxy) => [
      observed(
        await proxy.requestDrag({
          x1: 1,
          y1: 2,
          x2: 3,
          y2: 4,
          pressDurationMs: 100,
          dragDurationMs: 600,
          holdDurationMs: 200,
          timeoutMs: 5000,
        }),
      ),
    ],
    expectedRequests: [
      {
        type: "request_drag",
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        pressDurationMs: 100,
        dragDurationMs: 600,
        holdDurationMs: 200,
      },
    ],
    expected: [{ success: true }],
  },
  {
    name: "requests reach the device in call order",
    replies: {
      request_tap_coordinates: capturedResponse("tap_coordinates_result"),
      request_swipe: capturedResponse("swipe_result"),
    },
    run: async (proxy) => [
      observed(await proxy.requestTapCoordinates({ x: 1, y: 2, duration: 50 })),
      observed(await proxy.requestSwipe({ x1: 5, y1: 6, x2: 7, y2: 8, duration: 120 })),
      observed(await proxy.requestTapCoordinates({ x: 3, y: 4, duration: 60 })),
    ],
    expectedRequests: [
      { type: "request_tap_coordinates", x: 1, y: 2, duration: 50 },
      { type: "request_swipe", x1: 5, y1: 6, x2: 7, y2: 8, duration: 120 },
      { type: "request_tap_coordinates", x: 3, y: 4, duration: 60 },
    ],
    expected: [{ success: true }, { success: true }, { success: true }],
  },
];

export function runAndroidCtrlProxyContract(
  name: string,
  factory: AndroidCtrlProxyHarnessFactory,
): void {
  describe(`AndroidCtrlProxy contract: ${name}`, () => {
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
