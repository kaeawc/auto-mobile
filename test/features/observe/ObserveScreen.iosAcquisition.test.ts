import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeIosVoiceOverDetector } from "../../fakes/FakeIosVoiceOverDetector";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../src/features/observe/ios/CtrlProxyHierarchy";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import type {
  CtrlProxyCachedHierarchy,
  HierarchyDelegateContext,
  XCTestHierarchy,
} from "../../../src/features/observe/ios/types";
import { ViewHierarchy } from "../../../src/features/observe/ViewHierarchy";
import {
  wasHierarchyReadDuringCall,
  withObservationReadScope,
} from "../../../src/features/observe/observationReadScope";
import { sanitizeObserveResult } from "../../../src/features/observe/output/ObserveResultOutput";
import { RequestManager } from "../../../src/utils/RequestManager";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { createObserveScreenForTest } from "./observeScreenTestBuilders";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";

const device = {
  name: "provenance-ios",
  deviceId: "provenance-ios-9821",
  platform: "ios",
} as const;
const raw: XCTestHierarchy = {
  updatedAt: 1000,
  packageName: "com.example.app",
  screenWidth: 390,
  screenHeight: 844,
  hierarchy: {
    className: "XCUIApplication",
    bounds: { left: 0, top: 0, right: 390, bottom: 844 },
    node: [
      { text: "Target", clickable: "true", bounds: { left: 10, top: 200, right: 90, bottom: 260 } },
    ],
  },
};
const cached = (hierarchy = raw): CtrlProxyCachedHierarchy => ({
  hierarchy,
  fresh: true,
  receivedAt: 1000,
  captureReceivedAt: 1000,
});
afterEach(() => {
  resetObserveCacheStore();
  displayTransitions.reset(device.deviceId);
});

function harness(
  initial: CtrlProxyCachedHierarchy | null,
  mode: "respond" | "fail" | "push" = "respond",
) {
  const timer = new FakeTimer();
  timer.setCurrentTime(1000);
  const requestManager = new RequestManager(timer);
  let cache = initial;
  const commands: Array<{ type: string; requestId: string }> = [];
  const context: HierarchyDelegateContext = {
    timer,
    requestManager,
    cacheFreshTtlMs: 5000,
    getCachedHierarchy: () => cache,
    setCachedHierarchy: (value) => {
      cache = value;
    },
    ensureConnected: async () => {
      if (mode === "push") {
        cache = cached({ ...raw, updatedAt: 1100 });
      }
      return mode === "respond";
    },
    cancelScreenshotBackoff: () => {},
    getWebSocket: () =>
      ({
        readyState: WebSocket.OPEN,
        send: (data: string) => {
          const command: { type: string; requestId: string } = JSON.parse(data);
          commands.push(command);
          requestManager.resolve(command.requestId, { hierarchy: raw });
        },
      }) as unknown as WebSocket,
  };
  const delegate = new CtrlProxyHierarchy(context);
  const client = new FakeIOSCtrlProxy(timer);
  const latest = spyOn(client, "getLatestHierarchy").mockImplementation((...args) =>
    delegate.getLatestHierarchy(...args),
  );
  const instance = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
    client as unknown as IOSCtrlProxyClient,
  );
  const adb = new FakeAdbClientFactory(new FakeAdbExecutor());
  const hierarchy = new ViewHierarchy(device, adb, timer);
  const screen = createObserveScreenForTest(
    device,
    adb,
    {
      viewHierarchy: hierarchy,
      window: new FakeWindow(),
      cacheStore: new FakeObserveCacheStore(timer),
    },
    timer,
  );
  return {
    timer,
    commands,
    context,
    delegate,
    client,
    hierarchy,
    screen,
    latest,
    restore: () => {
      latest.mockRestore();
      instance.mockRestore();
    },
  };
}
const acquisition = (response: object) =>
  Object.getOwnPropertySymbols(response).map((symbol) => Reflect.get(response, symbol));

describe("iOS acquisition through real delegate, normalization and observe projection", () => {
  test.each(["cache", "device", "unknown"] as const)(
    "only a synchronous device response records a read: %s",
    async (source) => {
      const h = harness(source === "device" ? null : cached());
      try {
        if (source === "unknown") {
          h.latest.mockResolvedValue({ hierarchy: raw, fresh: true, updatedAt: 1000 });
        }
        await withObservationReadScope(async () => {
          const result = await h.screen.execute({
            skipScreenshot: true,
            skipBackStack: true,
            freshness: "cached-ok",
          });
          expect(result.error).toBeUndefined();
          expect(result.viewHierarchy).toBeDefined();
          expect(wasHierarchyReadDuringCall(result.viewHierarchy!)).toBe(source === "device");
          expect(h.commands).toHaveLength(source === "device" ? 1 : 0);
          // Pin both raw serialization and the public sanitized observe output.
          const json = JSON.stringify(result);
          const output = JSON.stringify(sanitizeObserveResult(result, { dropElements: true }));
          expect(json).not.toContain("iosHierarchyAcquisition");
          expect(output).not.toContain("iosHierarchyAcquisition");
          expect(json).not.toContain("client-cache");
          expect(output).not.toContain("client-cache");
          if (source !== "unknown") {
            expect(acquisition(result.viewHierarchy!)).toContain(
              source === "device" ? "device" : "client-cache",
            );
          }
        });
      } finally {
        h.restore();
      }
    },
  );
  test.each(["fail", "push"] as const)(
    "a failed sync's fallback is a cache return, including a raced push: %s",
    async (mode) => {
      const h = harness({ ...cached(), fresh: false }, mode);
      try {
        const result = await h.delegate.getLatestHierarchy(false, 100, undefined, true);
        expect(result.hierarchy).not.toBeNull();
        expect(result.fresh).toBe(mode === "push");
        expect(acquisition(result)).toEqual(["client-cache"]);
      } finally {
        h.restore();
      }
    },
  );
  test.each([false, true])(
    "no hierarchy is never a device read (reconnect=%s)",
    async (reconnect) => {
      const h = harness(null, "fail");
      try {
        if (reconnect) {
          h.context.getReconnectStatus = () => ({
            state: "cooldown",
            retryAfterMs: 1000,
            retryAfterSeconds: 1,
            connectionAttempts: 1,
            maxConnectionAttempts: 3,
          });
        }
        const response = await h.delegate.getLatestHierarchy(false, 100);
        expect(response.hierarchy).toBeNull();
        expect(acquisition(response)).toEqual(["client-cache"]);
      } finally {
        h.restore();
      }
    },
  );
  test.each([false, true])(
    "public sync opt-in selects the actual command (forced=%s)",
    async (forceCapture) => {
      const h = harness(null);
      try {
        // Exercise the production public-client forwarding boundary without its transport constructor.
        const client = { hierarchy: h.delegate } as unknown as IOSCtrlProxyClient;
        const response = await (
          forceCapture
            ? IOSCtrlProxyClient.prototype.requestHierarchySyncForTapRevalidation
            : IOSCtrlProxyClient.prototype.requestHierarchySync
        ).call(client, undefined, false, undefined, 100);
        expect(response?.hierarchy).toBe(raw);
        expect(h.commands.map((command) => command.type)).toEqual([
          forceCapture ? "request_hierarchy" : "request_hierarchy_if_stale",
        ]);
      } finally {
        h.restore();
      }
    },
  );
});

for (const tool of ["tapOn", "tapAny"] as const) {
  test.each(["observe->tap", "tap->tap"])(
    `${tool} full-call device reads: %s`,
    async (scenario) => {
      const h = harness(null);
      h.timer.enableAutoAdvance();
      const sync = spyOn(h.client, "requestHierarchySync").mockImplementation(
        (perf, filtering, signal, timeout, options) =>
          h.delegate.requestHierarchySync(perf, filtering, signal, timeout, false, options),
      );
      const convert = spyOn(h.client, "convertToViewHierarchyResult").mockImplementation((value) =>
        h.delegate.convertToViewHierarchyResult(value),
      );
      const existing = spyOn(IOSCtrlProxyClient, "getExistingInstance").mockReturnValue(
        h.client as unknown as IOSCtrlProxyClient,
      );
      const invalidate = spyOn(h.client, "invalidateCache").mockImplementation(() => {
        const cache = h.context.getCachedHierarchy();
        if (cache) {
          h.context.setCachedHierarchy({ ...cache, fresh: false });
        }
      });
      try {
        const adb = new FakeAdbExecutor();
        const tap =
          tool === "tapOn"
            ? new TapOnElement(device, adb, {
                timer: h.timer,
                tapStrategy: new FakeTapStrategy(),
                visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
                selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
              })
            : new TapAnyElement(device, adb, {
                timer: h.timer,
                iosVoiceOverDetector: new FakeIosVoiceOverDetector(),
              });
        tap.observeScreen = h.screen;
        tap.window = new FakeWindow();
        tap.awaitIdle = new FakeAwaitIdle();
        tap.captureTerminalObservationScreenshot = async () => {};
        tap.recordDeferredPredictionOutcome = async () => {};
        if (tap instanceof TapOnElement) {
          tap.deriveTapEffectAfterPostTapObservation = async (_before, current) => ({
            observation: current,
            effect: { screenChanged: false, basis: "viewHierarchy unchanged" },
          });
        }
        const execute = h.screen.execute.bind(h.screen);
        h.screen.execute = (options) =>
          execute({ ...options, skipScreenshot: true, skipBackStack: true });
        const run = () =>
          tap.execute({
            text: "Target",
            action: "tap",
            retryIfNoChange: false,
            selectionStrategy: "first",
          });
        if (scenario === "observe->tap") {
          await h.screen.execute();
        } else {
          expect((await run()).success).toBe(true);
        }
        h.commands.length = 0;
        expect((await run()).success).toBe(true);
        const kinds = h.commands.map((command) => command.type);
        console.log(`${tool} ${scenario} full-call: ${JSON.stringify(kinds)}`);
        expect(kinds).toEqual(["request_hierarchy", "request_hierarchy_if_stale"]);
      } finally {
        sync.mockRestore();
        convert.mockRestore();
        existing.mockRestore();
        invalidate.mockRestore();
        h.restore();
      }
    },
  );
}
