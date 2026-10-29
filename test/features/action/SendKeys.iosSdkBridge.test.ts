import { describe, expect, test } from "bun:test";
import type { IosSdkTapOutcome } from "../../../src/features/action/IosSdkBridgeTapRouter";
import type {
  IosSdkBridgeTextRequest,
  IosSdkBridgeTextRouter,
} from "../../../src/features/action/IosSdkBridgeTextRouter";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import type { ObserveResult, ViewHierarchyNode } from "../../../src/models";
import { nodeAttributes } from "../../../src/models/ViewHierarchyResult";
import { ActionableError } from "../../../src/models/ActionableError";
import { typedObservation } from "./IosTypedTextTestHarness";
import { createSendKeysHarness, ios } from "./SendKeysTestHarness";
import { SendKeys } from "../../../src/features/action/SendKeys";
import { FakeTimer } from "../../fakes/FakeTimer";

/** The focused Email field as a merged bridge node with the given capture identity. */
function bridgeObservation(value: string, identity: number): ObserveResult {
  const observation = typedObservation(value);
  const parser = new DefaultElementParser();
  for (const root of parser.extractRootNodes(observation.viewHierarchy!)) {
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      const attributes = nodeAttributes(node);
      if (attributes.focused === "true" && attributes["hint-text"] === "Email") {
        attributes["sdk-element-id"] = "email";
        attributes["sdk-capture-identity"] = String(identity);
      }
    });
  }
  return observation;
}

class FakeTextRouter implements IosSdkBridgeTextRouter {
  requests: IosSdkBridgeTextRequest[] = [];
  constructor(
    private readonly reply: (request: IosSdkBridgeTextRequest) => IosSdkTapOutcome | Error,
  ) {}
  async perform(request: IosSdkBridgeTextRequest): Promise<IosSdkTapOutcome | null> {
    this.requests.push({ ...request, target: { ...request.target } });
    const reply = this.reply(request);
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  }
}

/** A field whose value the bridge (or XCTest) changes, read back through observe. */
function harness(reply: (request: IosSdkBridgeTextRequest) => IosSdkTapOutcome | Error) {
  const field = { value: "old", identity: 70 };
  const router = new FakeTextRouter((request) => {
    const outcome = reply(request);
    if (!(outcome instanceof Error) && outcome.backend === "sdk") {
      field.value = request.action === "insertText" ? field.value + request.text : "";
      field.identity++;
    }
    return outcome;
  });
  const h = createSendKeysHarness(
    ios,
    { execute: async () => bridgeObservation(field.value, field.identity) },
    undefined,
    { iosSdkTextRouter: router },
  );
  h.client.insert = async (text) => {
    h.clientCalls.push(`insert:${text}`);
    field.value += text;
    return { success: true };
  };
  h.client.clear = async () => {
    h.clientCalls.push("clear");
    field.value = "";
    return { success: true };
  };
  h.executor.setIosSdkTextTarget({ elementId: "email", observationIdentity: 41 });
  return { h, router, field };
}

describe("sendKeys on an iOS SDK bridge field (#5159)", () => {
  test("a replace clears and types through the bridge, never through XCTest", async () => {
    const { h, router, field } = harness(() => ({ backend: "sdk" }));
    const result = await h.executor.type({ action: "type", text: "new", operation: "replace" });
    expect(result).toMatchObject({ success: true, backend: "sdk" });
    expect(result.fallbackReason).toBeUndefined();
    expect(field.value).toBe("new");
    expect(h.clientCalls).toEqual([]);
    expect(router.requests.map((request) => request.action)).toEqual(["clearText", "insertText"]);
    // Each action uses the latest capture identity the executor read, not the focus-time one.
    expect(router.requests[0].target.observationIdentity).toBe(70);
    expect(router.requests[1].target.observationIdentity).toBe(71);
  });

  test("an unsupported insert types with XCTest and says why", async () => {
    const { h } = harness(() => ({ backend: "xctest", fallbackReason: "unsupported" }));
    const result = await h.executor.type({ action: "type", text: "!" });
    expect(result).toMatchObject({
      success: true,
      backend: "xctest",
      fallbackReason: "unsupported",
    });
    expect(h.clientCalls).toEqual(["insert:!"]);
  });

  test("a stale field fails the command closed with no XCTest typing", async () => {
    const { h } = harness(
      () => new ActionableError("The bridge rejected the text entry (stale_observation)."),
    );
    const result = await h.executor.type({ action: "type", text: "!" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("stale_observation");
    expect(h.clientCalls).toEqual([]);
  });

  test("the clear command reports the bridge backend", async () => {
    const { h, field } = harness(() => ({ backend: "sdk" }));
    const result = await h.executor.clear();
    expect(result).toMatchObject({ success: true, iosBackend: { backend: "sdk" } });
    expect(field.value).toBe("");
    expect(h.clientCalls).toEqual([]);
  });

  test("IME done on a bridge field is an XCTest fallback reported as unsupported", async () => {
    const { h } = harness(() => ({ backend: "sdk" }));
    const result = await h.executor.key({ action: "key", key: "done" });
    expect(result).toMatchObject({ backend: "xctest", fallbackReason: "unsupported" });
    expect(h.clientCalls).toEqual(["ime"]);
  });

  test("without a bridge target sendKeys stays on XCTest and reports no backend", async () => {
    const { h, router } = harness(() => ({ backend: "sdk" }));
    h.executor.setIosSdkTextTarget(undefined);
    const result = await h.executor.type({ action: "type", text: "!" });
    expect(result.backend).toBeUndefined();
    expect(h.clientCalls).toEqual(["insert:!"]);
    expect(router.requests).toEqual([]);
  });

  test("sendKeys follows a focused bridge field to the bridge, and forgets it on the next call", async () => {
    const { h, router } = harness(() => ({ backend: "sdk" }));
    h.executor.setIosSdkTextTarget(undefined);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const action = new SendKeys(ios, h.adbFactory, {
      timer,
      executor: h.executor,
      observer: { execute: async () => bridgeObservation("", 80) },
      timestampProvider: { now: async () => 1 },
      focuser: {
        focus: async () => ({
          success: true,
          focusVerified: true,
          sdkTarget: { elementId: "email", observationIdentity: 79 },
        }),
      },
    });
    const focusedCall = await action.execute([{ action: "type", text: "a" }], {
      elementId: "email",
    });
    expect(focusedCall.commands[0]).toMatchObject({ success: true, backend: "sdk" });
    expect(router.requests.map((request) => request.target.elementId)).toEqual(["email"]);

    const unfocusedCall = await action.execute([{ action: "type", text: "b" }]);
    expect(unfocusedCall.commands[0].backend).toBeUndefined();
    expect(router.requests).toHaveLength(1);
    expect(h.clientCalls).toEqual(["insert:b"]);
  });
});
