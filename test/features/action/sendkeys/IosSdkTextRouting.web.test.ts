import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../../src/models/ActionableError";
import type { IosSdkTapOutcome } from "../../../../src/features/action/IosSdkBridgeTapRouter";
import type { IosSdkBridgeTextRouter } from "../../../../src/features/action/IosSdkBridgeTextRouter";
import type {
  IosSdkWebTextRequest,
  IosSdkWebTextRouter,
} from "../../../../src/features/action/IosSdkWebTextRouter";
import { IosSdkTextRouting } from "../../../../src/features/action/sendkeys/IosSdkTextRouting";
import type { ViewHierarchyResult } from "../../../../src/models/ViewHierarchyResult";

/** One merged DOM field of web view `checkout`, as observe produces it; none when `present` is false. */
function observation(snapshotId: string, present = true): { viewHierarchy: ViewHierarchyResult } {
  const field = {
    $: {
      class: "UITextField",
      "web-view-id": "checkout",
      "web-snapshot-id": snapshotId,
      "web-element-id": "email",
    },
  };
  return {
    viewHierarchy: {
      hierarchy: {
        node: {
          $: { class: "Application" },
          node: [{ $: { class: "WKWebView" }, node: present ? [field] : [] }],
        },
      },
    },
  };
}

class FakeWebTextRouter implements IosSdkWebTextRouter {
  requests: IosSdkWebTextRequest[] = [];
  constructor(private readonly replies: Array<IosSdkTapOutcome | null | Error>) {}
  async perform(request: IosSdkWebTextRequest): Promise<IosSdkTapOutcome | null> {
    this.requests.push({ ...request, target: { ...request.target }, signal: undefined });
    const reply = this.replies.shift() ?? null;
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  }
}

const nativeRouter: IosSdkBridgeTextRouter = {
  perform: async () => {
    throw new Error("a web field must not reach the native bridge");
  },
};

function routing(
  replies: Array<IosSdkTapOutcome | null | Error>,
  next = observation("s2"),
): { text: IosSdkTextRouting; web: FakeWebTextRouter } {
  const web = new FakeWebTextRouter(replies);
  const text: IosSdkTextRouting = new IosSdkTextRouting({
    router: nativeRouter,
    webRouter: web,
    observe: async () => {
      text.observed(next);
    },
  });
  text.setTarget({ webViewId: "checkout", snapshotId: "s1", elementId: "email" });
  return { text, web };
}

const xctest = (calls: string[]) => async () => {
  calls.push("xctest");
  return { success: true };
};

const sdk: IosSdkTapOutcome = { backend: "sdk" };

describe("IosSdkTextRouting on a web-view field (#5162)", () => {
  test("a replace clears through the web view, then sets the value, naming the fresh snapshot", async () => {
    const { text, web } = routing([sdk, sdk]);
    const calls: string[] = [];
    const result = await text.tracked(async () => {
      await text.clear(undefined, xctest(calls));
      return text.insert("a@b.c", {}, xctest(calls));
    });
    expect(calls).toEqual([]);
    expect(result).toEqual({ success: true, iosBackend: { backend: "sdk" } });
    expect(web.requests.map(({ action, text: value, target }) => [action, value, target])).toEqual([
      ["clear", undefined, { webViewId: "checkout", snapshotId: "s2", elementId: "email" }],
      ["setValue", "a@b.c", { webViewId: "checkout", snapshotId: "s2", elementId: "email" }],
    ]);
  });

  test("typing without a clear stays on XCTest: setValue would replace the field's text", async () => {
    const { text, web } = routing([sdk]);
    const calls: string[] = [];
    const result = await text.tracked(() => text.insert("more", {}, xctest(calls)));
    expect(calls).toEqual(["xctest"]);
    expect(web.requests).toEqual([]);
    expect(result.iosBackend).toEqual({ backend: "xctest", fallbackReason: "unsupported" });
  });

  test("a fresh read that no longer shows the field falls back to XCTest and says so", async () => {
    const { text, web } = routing([sdk], observation("s2", false));
    const calls: string[] = [];
    const result = await text.tracked(() => text.clear(undefined, xctest(calls)));
    expect(calls).toEqual(["xctest"]);
    expect(web.requests).toEqual([]);
    expect(result.iosBackend).toEqual({ backend: "xctest", fallbackReason: "unavailable" });
  });

  test("IME done submits the field's form; other IME actions report the XCTest fallback", async () => {
    const { text, web } = routing([sdk]);
    const calls: string[] = [];
    let dispatched = 0;
    const done = await text.tracked(() =>
      text.ime("done", undefined, xctest(calls), () => dispatched++),
    );
    expect(done).toEqual({ success: true, iosBackend: { backend: "sdk" } });
    // A sent submit marks the command dispatched, so a retry does not submit the form again.
    expect(dispatched).toBe(1);
    expect(web.requests.map(({ action }) => action)).toEqual(["submit"]);
    const next = await text.tracked(() => text.ime("next", undefined, xctest(calls)));
    expect(next.iosBackend).toEqual({ backend: "xctest", fallbackReason: "unsupported" });
    expect(calls).toEqual(["xctest"]);
  });

  test("a rejected web action fails closed instead of falling back to XCTest", async () => {
    const { text } = routing([new ActionableError("rejected the clear (stale_snapshot)")]);
    const calls: string[] = [];
    await expect(text.tracked(() => text.clear(undefined, xctest(calls)))).rejects.toThrow(
      "stale_snapshot",
    );
    expect(calls).toEqual([]);
  });

  test("an unavailable bridge falls back to XCTest, and routing off reports nothing", async () => {
    const calls: string[] = [];
    const unavailable = routing([{ backend: "xctest", fallbackReason: "unavailable" }]);
    const fellBack = await unavailable.text.tracked(() =>
      unavailable.text.clear(undefined, xctest(calls)),
    );
    expect(fellBack.iosBackend).toEqual({ backend: "xctest", fallbackReason: "unavailable" });
    const off = routing([null]);
    const plain = await off.text.tracked(() => off.text.clear(undefined, xctest(calls)));
    expect(plain.iosBackend).toBeUndefined();
    expect(calls).toEqual(["xctest", "xctest"]);
  });
});
