import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CtrlProxyNetworkSync } from "../../../../src/features/observe/ios/CtrlProxyNetworkSync";
import type { HierarchyDelegateContext } from "../../../../src/features/observe/ios/types";
import { NetworkState } from "../../../../src/utils/NetworkState";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { serverConfig } from "../../../../src/utils/ServerConfig";
import { serializeIosRequest } from "../../../../src/features/observe/ios/serializeIosRequest";
import { FakeOpenSocket } from "../../../fakes/FakeOpenSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { drainUntil } from "../../../helpers/fakeTimerStepping";

const DEVICE_ID = "03731F37-F704-4176-8C1E-0A5A1E5104FA";

/** Release-time network clear against a fake runner connection (#15179). */
function createSync() {
  const timer = new FakeTimer();
  const requestManager = new RequestManager(timer);
  const sent: Array<Record<string, unknown>> = [];
  const runner = { appHasSdk: false, socketOpen: true, replyOk: true, holdReplies: false };
  const held: string[] = [];
  const context: HierarchyDelegateContext = {
    serializeRequest: serializeIosRequest,
    getWebSocket: () => new FakeOpenSocket(),
    requestManager,
    timer,
    ensureConnected: async () => true,
    cancelScreenshotBackoff: () => {},
    cacheFreshTtlMs: 0,
    getCachedHierarchy: () => null,
    setCachedHierarchy: () => {},
  };
  const sync = new CtrlProxyNetworkSync({
    getDevice: () => ({ deviceId: DEVICE_ID, platform: "ios", name: "fake" }),
    requestManager,
    sdkCapability: {
      hasSdkCapability: () => runner.appHasSdk,
      isLegacySdkCommandSupported: () => false,
      ensureSdkCapability: async () => runner.appHasSdk,
      sdkCapabilityGate: async () => null,
    },
    sendMessage: (data) => {
      if (!runner.socketOpen) {
        return false;
      }
      const message = JSON.parse(data) as Record<string, unknown>;
      sent.push(message);
      if (message.type === "set_network_mock_rules" && typeof message.requestId === "string") {
        if (runner.holdReplies) {
          held.push(message.requestId);
          return true;
        }
        requestManager.resolve(message.requestId, {
          success: runner.replyOk,
          rejectedMockIds: [],
        });
      }
      return true;
    },
    isCommandSupported: () => true,
    createDelegateContext: () => context,
  });
  const release = (requestId: string): void => {
    requestManager.resolve(requestId, { success: true, rejectedMockIds: [] });
  };
  return { sync, runner, sent, held, release };
}

function addRule(state: NetworkState): void {
  state.addMock(DEVICE_ID, {
    host: "example\\.com",
    path: "/.*",
    method: "*",
    limit: null,
    statusCode: 503,
    responseHeaders: {},
    responseBody: "{}",
    contentType: "application/json",
  });
}

describe("CtrlProxyNetworkSync.syncNetworkStateFromHost release clear (#15179)", () => {
  let state: NetworkState;
  let previousMockable: boolean;

  beforeEach(() => {
    NetworkState.resetInstance();
    state = NetworkState.getInstance();
    previousMockable = serverConfig.isNetworkMockableEnabled();
    serverConfig.setNetworkMockableEnabled(true);
  });

  afterEach(() => {
    serverConfig.setNetworkMockableEnabled(previousMockable);
    NetworkState.resetInstance();
  });

  test("an app without the SDK that never received rules has nothing to clear", async () => {
    const { sync, sent } = createSync();
    addRule(state); // stored on the host only: the mockNetwork call was noCapability

    await expect(sync.syncNetworkStateFromHost({})).resolves.toBeUndefined();
    expect(sent.filter((m) => m.type === "set_network_mock_rules")).toEqual([]);
  });

  test("a delivered clear leaves the release clean and the next session unflagged", async () => {
    const { sync, runner, sent } = createSync();
    runner.appHasSdk = true;
    addRule(state);
    await sync.syncNetworkMockRulesIfAvailable({});
    state.clearAllMocks(DEVICE_ID);

    await expect(sync.syncNetworkStateFromHost({})).resolves.toBeUndefined();
    const lastRules = sent.filter((m) => m.type === "set_network_mock_rules").at(-1);
    expect(lastRules?.rules).toEqual([]);

    // The empty set was confirmed, so a later app without the SDK holds nothing stale.
    runner.appHasSdk = false;
    await expect(sync.syncNetworkStateFromHost({})).resolves.toBeUndefined();
  });

  test("rules delivered to an SDK app that is no longer reachable still escalate", async () => {
    const { sync, runner } = createSync();
    runner.appHasSdk = true;
    addRule(state);
    await sync.syncNetworkMockRulesIfAvailable({});
    state.clearAllMocks(DEVICE_ID);
    runner.appHasSdk = false;

    await expect(sync.syncNetworkStateFromHost({})).rejects.toThrow(
      "iOS network mock rules were not delivered",
    );
  });

  test("a failed clear push to a running SDK app escalates and keeps escalating", async () => {
    const { sync, runner } = createSync();
    runner.appHasSdk = true;
    addRule(state);
    await sync.syncNetworkMockRulesIfAvailable({});
    state.clearAllMocks(DEVICE_ID);
    runner.socketOpen = false;

    await expect(sync.syncNetworkStateFromHost({})).rejects.toThrow(
      "iOS network mock rules were not delivered",
    );
    runner.socketOpen = true;
    runner.appHasSdk = false;
    // The failed clear never reached the app, so its rules may remain.
    await expect(sync.syncNetworkStateFromHost({})).rejects.toThrow(
      "iOS network mock rules were not delivered",
    );
  });

  test("a runner that rejects the empty set does not count as cleared", async () => {
    const { sync, runner } = createSync();
    runner.appHasSdk = true;
    addRule(state);
    await sync.syncNetworkMockRulesIfAvailable({});
    state.clearAllMocks(DEVICE_ID);
    runner.replyOk = false;

    await expect(sync.syncNetworkStateFromHost({})).rejects.toThrow(
      "iOS network mock rules were not delivered",
    );
    runner.replyOk = true;
    runner.appHasSdk = false;
    await expect(sync.syncNetworkStateFromHost({})).rejects.toThrow(
      "iOS network mock rules were not delivered",
    );
  });

  test("a late empty-set confirmation cannot clear rules written after it", async () => {
    const { sync, runner, held, release } = createSync();
    runner.appHasSdk = true;
    runner.holdReplies = true;
    addRule(state);
    const first = sync.syncNetworkMockRulesIfAvailable({});
    await drainUntil(() => held.length === 1, { description: "first push sent" });
    release(held[0]!);
    await first;
    state.clearAllMocks(DEVICE_ID);
    const emptyPush = sync.syncNetworkMockRulesIfAvailable({});
    await drainUntil(() => held.length === 2, { description: "empty push sent" });
    addRule(state); // a new mockNetwork lands while the empty set is unconfirmed
    const newerPush = sync.syncNetworkMockRulesIfAvailable({});
    await drainUntil(() => held.length === 3, { description: "newer push sent" });
    release(held[1]!);
    await emptyPush;
    release(held[2]!);
    await newerPush;
    state.clearAllMocks(DEVICE_ID);
    runner.holdReplies = false;
    runner.appHasSdk = false;

    await expect(sync.syncNetworkStateFromHost({})).rejects.toThrow(
      "iOS network mock rules were not delivered",
    );
  });
});
