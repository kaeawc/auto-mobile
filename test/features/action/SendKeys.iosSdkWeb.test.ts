import { describe, expect, test } from "bun:test";
import type { IosSdkTapOutcome } from "../../../src/features/action/IosSdkBridgeTapRouter";
import type { IosSdkBridgeTextRouter } from "../../../src/features/action/IosSdkBridgeTextRouter";
import type {
  IosSdkWebTextRequest,
  IosSdkWebTextRouter,
} from "../../../src/features/action/IosSdkWebTextRouter";
import { sdkTargetField } from "../../../src/features/action/SendKeys";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import type { Element, ObserveResult, ViewHierarchyNode } from "../../../src/models";
import { nodeAttributes } from "../../../src/models/ViewHierarchyResult";
import { typedObservation } from "./IosTypedTextTestHarness";
import { android, createSendKeysHarness, ios } from "./SendKeysTestHarness";

/** The focused Email field as a DOM element merged from web view `checkout`. */
function webObservation(value: string, snapshotId: string): ObserveResult {
  const observation = typedObservation(value);
  const parser = new DefaultElementParser();
  for (const root of parser.extractRootNodes(observation.viewHierarchy!)) {
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      const attributes = nodeAttributes(node);
      if (attributes.focused === "true" && attributes["hint-text"] === "Email") {
        attributes["web-view-id"] = "checkout";
        attributes["web-snapshot-id"] = snapshotId;
        attributes["web-element-id"] = "email";
      }
    });
  }
  return observation;
}

class FakeWebTextRouter implements IosSdkWebTextRouter {
  requests: IosSdkWebTextRequest[] = [];
  constructor(private readonly onRequest: (request: IosSdkWebTextRequest) => void) {}
  async perform(request: IosSdkWebTextRequest): Promise<IosSdkTapOutcome | null> {
    this.requests.push({ ...request, target: { ...request.target }, signal: undefined });
    this.onRequest(request);
    return { backend: "sdk" };
  }
}

const nativeRouter: IosSdkBridgeTextRouter = {
  perform: async () => {
    throw new Error("a web field must not reach the native bridge");
  },
};

/** A web field whose value the web view (or XCTest) changes, read back through observe. */
function harness() {
  const field = { value: "old", snapshot: 1 };
  const web = new FakeWebTextRouter((request) => {
    if (request.action === "setValue") {
      field.value = request.text ?? "";
    } else if (request.action === "clear") {
      field.value = "";
    }
    field.snapshot++;
  });
  const h = createSendKeysHarness(
    ios,
    { execute: async () => webObservation(field.value, `s${field.snapshot}`) },
    undefined,
    { iosSdkTextRouter: nativeRouter, iosSdkWebTextRouter: web },
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
  h.executor.setIosSdkTextTarget({ webViewId: "checkout", snapshotId: "s0", elementId: "email" });
  return { h, web, field };
}

describe("sendKeys on a web-view field (#5162)", () => {
  test("a replace clears and sets the value through the web view, never through XCTest", async () => {
    const { h, web, field } = harness();
    const result = await h.executor.type({ action: "type", text: "new", operation: "replace" });
    expect(result).toMatchObject({ success: true, backend: "sdk" });
    expect(field.value).toBe("new");
    expect(h.clientCalls).toEqual([]);
    expect(web.requests.map(({ action }) => action)).toEqual(["clear", "setValue"]);
    // Each action names the snapshot the executor last read, not the focus-time one.
    expect(web.requests[0].target.snapshotId).toBe("s1");
  });

  test("typing that appends stays on XCTest and says the web view cannot do it", async () => {
    const { h, web, field } = harness();
    const result = await h.executor.type({ action: "type", text: "!" });
    expect(result).toMatchObject({
      success: true,
      backend: "xctest",
      fallbackReason: "unsupported",
    });
    expect(field.value).toBe("old!");
    expect(h.clientCalls).toEqual(["insert:!"]);
    expect(web.requests).toEqual([]);
  });

  test("the clear command clears through the web view", async () => {
    const { h, field } = harness();
    const result = await h.executor.clear();
    expect(result).toMatchObject({ success: true, iosBackend: { backend: "sdk" } });
    expect(field.value).toBe("");
    expect(h.clientCalls).toEqual([]);
  });

  test("IME done submits the field's form through the web view", async () => {
    const { h, web } = harness();
    const result = await h.executor.key({ action: "key", key: "done" });
    expect(result).toMatchObject({ success: true, backend: "sdk" });
    expect(h.clientCalls).toEqual([]);
    expect(web.requests.map(({ action }) => action)).toEqual(["submit"]);
  });
});

describe("the focused field's bridge identity (#5162)", () => {
  const webField = {
    "web-view-id": "checkout",
    "web-snapshot-id": "s4",
    "web-element-id": "email",
    bounds: { left: 0, top: 0, right: 10, bottom: 10 },
  } as Element;

  test("a merged DOM element yields its web identity on iOS", () => {
    expect(sdkTargetField(ios, webField)).toEqual({
      sdkTarget: { webViewId: "checkout", snapshotId: "s4", elementId: "email" },
    });
  });

  test("a native bridge node wins, and Android or no element yields nothing", () => {
    const both = { ...webField, "sdk-element-id": "n1", "sdk-capture-identity": "9" } as Element;
    expect(sdkTargetField(ios, both)).toEqual({
      sdkTarget: { elementId: "n1", observationIdentity: 9 },
    });
    expect(sdkTargetField(android, webField)).toEqual({});
    expect(sdkTargetField(ios, undefined)).toEqual({});
  });
});

describe("keys that move focus away from the web field (#5162)", () => {
  test.each(["next", "tab"] as const)(
    "after %s, a clear follows focus through XCTest instead of the first field",
    async (key) => {
      const { h, web } = harness();
      await h.executor.key({ action: "key", key });
      const result = await h.executor.clear();
      expect(web.requests).toEqual([]);
      expect(h.clientCalls).toContain("clear");
      expect(result.iosBackend).toBeUndefined();
    },
  );
});
