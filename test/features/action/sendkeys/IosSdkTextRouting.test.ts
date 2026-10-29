import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../../src/models/ActionableError";
import type { IosSdkTapOutcome } from "../../../../src/features/action/IosSdkBridgeTapRouter";
import type {
  IosSdkBridgeTextRequest,
  IosSdkBridgeTextRouter,
} from "../../../../src/features/action/IosSdkBridgeTextRouter";
import { IosSdkTextRouting } from "../../../../src/features/action/sendkeys/IosSdkTextRouting";
import type { ViewHierarchyResult } from "../../../../src/models/ViewHierarchyResult";

/** One merged bridge field under an app node, as observe produces it. */
function observation(
  identity: number,
  elementId = "email",
): { viewHierarchy: ViewHierarchyResult } {
  return {
    viewHierarchy: {
      hierarchy: {
        node: {
          $: { class: "Application" },
          node: [
            { $: { class: "Button", text: "Done" } },
            {
              $: {
                class: "TextField",
                "sdk-element-id": elementId,
                "sdk-capture-identity": String(identity),
              },
            },
          ],
        },
      },
    },
  };
}

class FakeTextRouter implements IosSdkBridgeTextRouter {
  requests: IosSdkBridgeTextRequest[] = [];
  constructor(private readonly replies: Array<IosSdkTapOutcome | null | Error>) {}
  async perform(request: IosSdkBridgeTextRequest): Promise<IosSdkTapOutcome | null> {
    this.requests.push({ ...request, target: { ...request.target } });
    const reply = this.replies.shift() ?? null;
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  }
}

function routing(replies: Array<IosSdkTapOutcome | null | Error>, observed = 50) {
  const router = new FakeTextRouter(replies);
  let reads = 0;
  const text: IosSdkTextRouting = new IosSdkTextRouting({
    router,
    observe: async () => {
      reads++;
      text.observed(observation(observed));
    },
  });
  return { text, router, reads: () => reads };
}

const xctestInsert = (calls: string[]) => async () => {
  calls.push("xctest");
  return { success: true };
};

describe("IosSdkTextRouting (#5159)", () => {
  test("a field that is not a bridge node types with XCTest and reports nothing", async () => {
    const { text, router } = routing([]);
    const calls: string[] = [];
    const result = await text.tracked(() => text.insert("hi", {}, xctestInsert(calls)));
    expect(result).toEqual({ success: true });
    expect(calls).toEqual(["xctest"]);
    expect(router.requests).toEqual([]);
    expect(text.imeFields()).toEqual({});
  });

  test("refreshes the focus-time identity once, then types through the bridge", async () => {
    const { text, router, reads } = routing([{ backend: "sdk", nextObservationIdentity: 51 }]);
    text.setTarget({ elementId: "email", observationIdentity: 41 });
    const calls: string[] = [];
    const result = await text.tracked(() => text.insert("hi", {}, xctestInsert(calls)));
    expect(result).toEqual({
      success: true,
      iosBackend: { backend: "sdk", nextObservationIdentity: 51 },
    });
    expect(calls).toEqual([]);
    expect(reads()).toBe(1);
    expect(router.requests[0]).toMatchObject({
      action: "insertText",
      text: "hi",
      target: { elementId: "email", observationIdentity: 50 },
    });
  });

  test("a replace clears then types, each with the identity the previous action returned", async () => {
    const { text, router, reads } = routing([
      { backend: "sdk", nextObservationIdentity: 61 },
      { backend: "sdk", nextObservationIdentity: 62 },
    ]);
    text.setTarget({ elementId: "email", observationIdentity: 41 });
    text.observed(observation(60));
    await text.tracked(async () => {
      await text.clear(undefined, xctestInsert([]));
      return text.insert("new", {}, xctestInsert([]));
    });
    expect(reads()).toBe(0);
    expect(router.requests.map((request) => request.target.observationIdentity)).toEqual([60, 61]);
  });

  test("a later observation's identity replaces the one the bridge last returned", async () => {
    const { text, router } = routing([
      { backend: "sdk", nextObservationIdentity: 61 },
      { backend: "sdk", nextObservationIdentity: 63 },
    ]);
    text.setTarget({ elementId: "email", observationIdentity: 41 });
    text.observed(observation(60));
    await text.clear(undefined, xctestInsert([]));
    text.observed(observation(62));
    text.observed(observation(99, "other-field"));
    await text.insert("x", {}, xctestInsert([]));
    expect(router.requests.map((request) => request.target.observationIdentity)).toEqual([60, 62]);
  });

  test("an unsupported action falls back to XCTest, and the fallback is what the command reports", async () => {
    const { text } = routing([
      { backend: "xctest", fallbackReason: "unsupported" },
      { backend: "sdk", nextObservationIdentity: 52 },
    ]);
    text.setTarget({ elementId: "email", observationIdentity: 41 });
    const calls: string[] = [];
    const result = await text.tracked(async () => {
      await text.clear(undefined, xctestInsert(calls));
      return text.insert("x", {}, xctestInsert(calls));
    });
    expect(calls).toEqual(["xctest"]);
    expect(result.iosBackend).toEqual({ backend: "xctest", fallbackReason: "unsupported" });
  });

  test("a fail-closed rejection propagates without an XCTest attempt", async () => {
    const { text } = routing([new ActionableError("rejected the text entry (stale_observation)")]);
    text.setTarget({ elementId: "email", observationIdentity: 41 });
    const calls: string[] = [];
    await expect(text.insert("x", {}, xctestInsert(calls))).rejects.toThrow("stale_observation");
    expect(calls).toEqual([]);
  });

  test("routing off types with XCTest and reports nothing", async () => {
    const { text } = routing([null]);
    text.setTarget({ elementId: "email", observationIdentity: 41 });
    const calls: string[] = [];
    const result = await text.tracked(() => text.insert("x", {}, xctestInsert(calls)));
    expect(calls).toEqual(["xctest"]);
    expect(result.iosBackend).toBeUndefined();
  });

  test("an IME action on a bridge field reports the unsupported XCTest fallback", () => {
    const { text } = routing([]);
    text.setTarget({ elementId: "email", observationIdentity: 41 });
    expect(text.imeFields()).toEqual({ backend: "xctest", fallbackReason: "unsupported" });
    text.setTarget(undefined);
    expect(text.imeFields()).toEqual({});
  });
});
