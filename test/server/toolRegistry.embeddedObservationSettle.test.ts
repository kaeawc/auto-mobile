import { describe, expect, spyOn, test } from "bun:test";
import { DefaultAfterToolCallHandler } from "../../src/server/toolRegistry";
import { RealSettleObserve } from "../../src/features/observe/SettleObserve";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import type { BootedDevice } from "../../src/models";
import type { ObserveResult } from "../../src/models/ObserveResult";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { serverConfig } from "../../src/utils/ServerConfig";

/**
 * Wiring coverage for the #6866 settle gate inside the after-tool-call
 * pipeline: the finalized response a client receives must carry the settled
 * observation and its `settled` verdict. Session storage uses fake persistence;
 * all polling runs on FakeObserveScreen + FakeTimer without a live daemon.
 */

const device: BootedDevice = {
  name: "Pixel",
  deviceId: "emulator-5554",
  platform: "android",
};

function obs(text: string, updatedAt: number): ObserveResult {
  return {
    updatedAt,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    activeWindow: {
      appId: "com.android.settings",
      activityName: ".SubSettings",
      layoutSeqSum: 1,
    },
    viewHierarchy: {
      packageName: "com.android.settings",
      hierarchy: {
        node: {
          class: "android.widget.TextView",
          "resource-id": "android:id/title",
          text,
        } as any,
      },
      updatedAt,
    },
  } as ObserveResult;
}

function handlerWith(fake: FakeObserveScreen): DefaultAfterToolCallHandler {
  return new DefaultAfterToolCallHandler(
    undefined,
    (_device, timer) => new RealSettleObserve(fake, timer),
  );
}

async function runAfterToolCall(
  handler: DefaultAfterToolCallHandler,
  name: string,
  response: unknown,
  timer: FakeTimer,
  options: { args?: Record<string, unknown>; device?: BootedDevice; sessionUuid?: string } = {},
) {
  return handler.handle({
    name,
    outputSchema: undefined,
    args: options.args ?? {},
    device: options.device ?? device,
    internalCall: false,
    response,
    sessionUuid: options.sessionUuid,
    shouldResolveDevice: options.sessionUuid !== undefined,
    timer,
    toolStartMs: 0,
  });
}

describe("DefaultAfterToolCallHandler embedded-observation settle (#6866)", () => {
  test.each([false, true])(
    "explicit-display settle retains the rendered session panel (wrong-panel capture: %s)",
    async (wrongPanel) => {
      const timer = new FakeTimer();
      const sessions = new SessionManager(timer, {
        getSession: async () => null,
        upsertActiveSession: async () => {},
        recordActivity: async () => {},
        markReleased: async () => {},
        markStaleActiveSessionsExpired: async () => {},
      });
      sessions.stopCleanupTimer();
      const sessionUuid = "explicit-display-settle";
      await sessions.createSession(sessionUuid, device.deviceId, "android");
      timer.enableAutoAdvance();
      const action = obs("external panel loading", 10);
      action.display = { key: "external-key", role: "external", posture: "unknown", generation: 2 };
      sessions.setLastRenderedObservation(sessionUuid, action);
      const twoDisplayDevice: BootedDevice = {
        ...device,
        displays: {
          panels: [
            { key: "internal-key", role: "inner", sizePx: action.screenSize },
            { key: "external-key", role: "external", sizePx: action.screenSize },
          ],
          postures: [],
        },
      };
      const fake = new FakeObserveScreen();
      fake.setObserveResult((index) => {
        const requested = fake.getExecuteOptions().at(-1)?.display;
        const external = !wrongPanel && requested === "external-key";
        const capture = obs(
          external ? "external panel settled" : "internal panel content",
          20 + index,
        );
        capture.display = external
          ? { ...action.display }
          : { key: "internal-key", role: "inner", posture: "unknown", generation: 2 };
        return capture;
      });
      const daemon = DaemonState.getInstance();
      const initialized = spyOn(daemon, "isInitialized").mockReturnValue(true);
      const manager = spyOn(daemon, "getSessionManager").mockReturnValue(sessions);
      const diff = spyOn(serverConfig, "isActionsDiffObserveEnabled").mockReturnValue(true);
      const noObserve = spyOn(serverConfig, "isActionsNoObserveEnabled").mockReturnValue(false);
      try {
        const result = await runAfterToolCall(
          handlerWith(fake),
          "tapOn",
          createStructuredToolResponse({ success: true, observation: action }),
          timer,
          { args: { display: "external", raw: true }, device: twoDisplayDevice, sessionUuid },
        );
        const payload = JSON.parse(result.finalizedResponse.content[0].text);
        expect(payload.observation.display.key).toBe("external-key");
        expect(payload.observation.settled).toBe(!wrongPanel);
        expect(sessions.getLastRenderedDisplayKey(sessionUuid)).toBe("external-key");
        expect(sessions.getLastRenderedObservation(sessionUuid)?.display.key).toBe("external-key");
        expect(sessions.getSession(sessionUuid)?.cacheData.lastHierarchy).toEqual(
          sessions.getLastRenderedObservation(sessionUuid)?.viewHierarchy,
        );
        expect(sessions.getLastRenderedObservation(sessionUuid)?.viewHierarchy).toMatchObject({
          hierarchy: {
            node: { text: wrongPanel ? "external panel loading" : "external panel settled" },
          },
        });
        expect(sessions.getLastRenderedObservation(sessionUuid)?.updatedAt).toBe(
          wrongPanel ? 10 : 21,
        );
        expect(fake.getExecuteOptions().length).toBeGreaterThan(0);
        expect(
          fake.getExecuteOptions().every((options) => options.display === "external-key"),
        ).toBe(true);
      } finally {
        noObserve.mockRestore();
        diff.mockRestore();
        manager.mockRestore();
        initialized.mockRestore();
        sessions.stopCleanupTimer();
      }
    },
  );

  test.each(["android", "ios"] as const)(
    "a default %s action adopts the settled capture with a different display key",
    async (platform) => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const fake = new FakeObserveScreen();
      const action = obs("loading", 10);
      action.platform = platform;
      action.display = { key: "0", role: "unknown", posture: "unknown", generation: 0 };
      action.selectedElements = [];
      const settled = obs("settled", 20);
      settled.platform = platform;
      settled.display = {
        key: "focused-panel",
        role: "unknown",
        posture: "unknown",
        generation: 0,
      };
      if (platform === "ios") {
        action.activeWindow = settled.activeWindow = { appId: "com.example.app" };
        action.screenSize = { width: 0, height: 0 };
        settled.screenSize = { width: 1170, height: 2532 };
        action.viewHierarchy!.packageName = settled.viewHierarchy!.packageName = "com.example.app";
        action.viewHierarchy!.hierarchy = {
          node: { class: "XCUIElementTypeStaticText", label: "Loading" },
        };
        settled.viewHierarchy!.hierarchy = {
          node: { class: "XCUIElementTypeStaticText", label: "Ready" },
        };
      }
      fake.setObserveSequence([
        settled,
        { ...settled, updatedAt: 30, viewHierarchy: { ...settled.viewHierarchy!, updatedAt: 30 } },
      ]);

      const result = await runAfterToolCall(
        handlerWith(fake),
        "tapOn",
        createStructuredToolResponse({ success: true, observation: action }),
        timer,
        { args: { raw: true }, device: { ...device, platform } },
      );
      const payload = JSON.parse(result.finalizedResponse.content[0].text);
      expect(payload.observation.display.key).toBe("focused-panel");
      expect(payload.observation.selectedElements).toEqual([]);
      expect(payload.observation.updatedAt).toBe(30);
      expect(payload.observation.settled).toBe(true);
      expect(fake.getExecuteOptions().every((options) => options.display === undefined)).toBe(true);
    },
  );

  test("tapOn's finalized observation is the settled capture, flagged settled:true", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs("Airplane mode", 20), obs("Airplane mode", 30)]);

    const response = createStructuredToolResponse({
      success: true,
      action: "tap",
      observation: obs("loading", 10),
    });

    const result = await runAfterToolCall(handlerWith(fake), "tapOn", response, timer);
    const payload = JSON.parse(result.finalizedResponse.content[0].text);

    expect(payload.observation.settled).toBe(true);
    expect(fake.getExecuteCallCount()).toBeGreaterThan(0);
  });

  test("an in-place action is not re-observed and reports settled:false", async () => {
    const timer = new FakeTimer();
    const fake = new FakeObserveScreen();
    fake.setObserveResult(obs("Airplane mode", 20));

    const response = createStructuredToolResponse({
      success: true,
      observation: obs("Airplane mode", 10),
    });

    const result = await runAfterToolCall(handlerWith(fake), "sendKeys", response, timer);
    const payload = JSON.parse(result.finalizedResponse.content[0].text);

    expect(payload.observation.settled).toBe(false);
    expect(fake.getExecuteCallCount()).toBe(0);
  });

  test("a failed action's observation is stamped settled:false without re-observing", async () => {
    const timer = new FakeTimer();
    const fake = new FakeObserveScreen();
    fake.setObserveResult(obs("Airplane mode", 20));

    const response = createStructuredToolResponse({
      success: false,
      error: "command failed",
      observation: obs("Airplane mode", 10),
    });

    const result = await runAfterToolCall(handlerWith(fake), "tapOn", response, timer);
    const payload = JSON.parse(result.finalizedResponse.content[0].text);

    expect(payload.observation.settled).toBe(false);
    expect(fake.getExecuteCallCount()).toBe(0);
  });

  test("the `observe` tool owns its own settle and is never re-observed here", async () => {
    const timer = new FakeTimer();
    const fake = new FakeObserveScreen();
    fake.setObserveResult(obs("Airplane mode", 20));

    const response = createStructuredToolResponse(obs("Airplane mode", 10));
    await runAfterToolCall(handlerWith(fake), "observe", response, timer);

    expect(fake.getExecuteCallCount()).toBe(0);
  });
});
