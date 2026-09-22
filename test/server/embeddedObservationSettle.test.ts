import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../src/models/ObserveResult";
import {
  EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS,
  settleEmbeddedObservation,
  settleEmbeddedObservationInResponse,
} from "../../src/server/embeddedObservationSettle";
import { RealSettleObserve } from "../../src/features/observe/SettleObserve";
import { assignStableViewIds } from "../../src/features/observe/android/StableNodeIdentity";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Unit coverage for the navigation-class embedded-observation settle gate
 * (issue #6866). Everything runs on FakeObserveScreen + FakeTimer: no device,
 * no DB, no real clock.
 */

/** Airplane-mode row as Android inflates it: first without, then with, the switch child. */
const AIRPLANE_ROW_HALF_INFLATED = {
  class: "android.widget.LinearLayout",
  "resource-id": "android:id/list_container",
  node: {
    class: "android.widget.RelativeLayout",
    "view-id": "1f0e3dad-9990-4fb4-a5c3-7f2a1b0c9d8e",
    node: {
      class: "android.widget.TextView",
      "resource-id": "android:id/title",
      text: "Airplane mode",
      "view-id": "2f0e3dad-9990-4fb4-a5c3-7f2a1b0c9d8e",
    },
  },
};

const AIRPLANE_ROW_INFLATED = {
  class: "android.widget.LinearLayout",
  "resource-id": "android:id/list_container",
  node: {
    class: "android.widget.RelativeLayout",
    "view-id": "1f0e3dad-9990-4fb4-a5c3-7f2a1b0c9d8e",
    node: [
      {
        class: "android.widget.TextView",
        "resource-id": "android:id/title",
        text: "Airplane mode",
        "view-id": "2f0e3dad-9990-4fb4-a5c3-7f2a1b0c9d8e",
      },
      {
        class: "android.widget.Switch",
        "resource-id": "com.android.settings:id/switchWidget",
        checkable: "true",
        checked: "false",
        "view-id": "com.android.settings:id/switchWidget",
      },
    ],
  },
};

function obs(node: Record<string, unknown>, updatedAt: number): ObserveResult {
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
      hierarchy: { node: structuredClone(node) as any },
      updatedAt,
    },
  } as ObserveResult;
}

/** The content-derived `s2-…` id the skeleton projection would emit for the row. */
function airplaneRowStableId(observation: ObserveResult): string {
  const root = structuredClone(observation.viewHierarchy!.hierarchy) as Record<string, unknown>;
  assignStableViewIds(root);
  return ((root.node as any).node as Record<string, unknown>)["view-id"] as string;
}

function settleFor(fake: FakeObserveScreen, timer: FakeTimer): RealSettleObserve {
  return new RealSettleObserve(fake, timer);
}

describe("settleEmbeddedObservation (#6866)", () => {
  test("navigation-class capture is replaced by the settled hierarchy and marked settled", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([
      obs(AIRPLANE_ROW_INFLATED, 20),
      obs(AIRPLANE_ROW_INFLATED, 30),
      obs(AIRPLANE_ROW_INFLATED, 40),
    ]);

    const halfInflated = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: halfInflated,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(true);
    // The switch child — the only carrier of toggle/checked — is now present.
    const children = (outcome.observation.viewHierarchy!.hierarchy.node as any).node.node;
    expect(Array.isArray(children)).toBe(true);
    expect(children[1]["resource-id"]).toBe("com.android.settings:id/switchWidget");
  });

  test("elementId stability: the settled row id equals the id a later observe emits", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([
      obs(AIRPLANE_ROW_INFLATED, 20),
      obs(AIRPLANE_ROW_INFLATED, 30),
      obs(AIRPLANE_ROW_INFLATED, 40),
    ]);

    const halfInflated = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    // Precondition: the half-inflated capture hashes to a DIFFERENT id — that
    // is the client-visible symptom reported in #6866.
    const laterObserve = obs(AIRPLANE_ROW_INFLATED, 99);
    expect(airplaneRowStableId(halfInflated)).not.toBe(airplaneRowStableId(laterObserve));

    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: halfInflated,
      settleObserve: settleFor(fake, timer),
    });

    expect(airplaneRowStableId(outcome.observation)).toBe(airplaneRowStableId(laterObserve));
  });

  test("metadata only the action could attach survives the replacement", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs(AIRPLANE_ROW_INFLATED, 20), obs(AIRPLANE_ROW_INFLATED, 30)]);

    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    // Written onto the capture by the action pipeline, never by ObserveScreen.
    (captured as any).gfxMetrics = { totalFrames: 12 };
    (captured as any).selectedElements = [{ text: "Airplane mode" }];

    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(true);
    expect((outcome.observation as any).gfxMetrics).toEqual({ totalFrames: 12 });
    expect((outcome.observation as any).selectedElements).toEqual([{ text: "Airplane mode" }]);
    // ...while the hierarchy itself is the settled one, not the half-inflated one.
    expect((outcome.observation.viewHierarchy!.hierarchy.node as any).node.node.length).toBe(2);
  });

  test("in-place actions keep the single capture and report settled:false", async () => {
    const timer = new FakeTimer();
    const fake = new FakeObserveScreen();
    fake.setObserveResult(obs(AIRPLANE_ROW_INFLATED, 20));

    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    const outcome = await settleEmbeddedObservation({
      actionClass: "inPlace",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(false);
    expect(outcome.observation).toBe(captured);
    expect(fake.getExecuteCallCount()).toBe(0);
  });

  test("scroll and unknown classes are likewise not gated", async () => {
    const timer = new FakeTimer();
    const fake = new FakeObserveScreen();
    fake.setObserveResult(obs(AIRPLANE_ROW_INFLATED, 20));
    for (const actionClass of ["scroll", "unknown"] as const) {
      const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
      const outcome = await settleEmbeddedObservation({
        actionClass,
        observation: captured,
        settleObserve: settleFor(fake, timer),
      });
      expect(outcome.settled).toBe(false);
      expect(outcome.observation).toBe(captured);
    }
    expect(fake.getExecuteCallCount()).toBe(0);
  });

  test("a never-stable screen reports settled:false within the bound", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // A ticking label: never two structurally-equal consecutive reads.
    fake.setObserveResult((index) =>
      obs(
        {
          class: "android.widget.TextView",
          "resource-id": "android:id/clock",
          text: `0:0${index}`,
        },
        20 + index * 10,
      ),
    );

    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(false);
    expect(timer.now()).toBeLessThan(EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS * 3);
  });

  test("the settle loop is forced strictly past the capture the action already holds", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs(AIRPLANE_ROW_INFLATED, 20), obs(AIRPLANE_ROW_INFLATED, 30)]);

    await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: obs(AIRPLANE_ROW_HALF_INFLATED, 10),
      settleObserve: settleFor(fake, timer),
    });

    // First poll floors at capture.updatedAt + 1 so a still-fresh cache entry
    // for the half-inflated tree cannot be served back as the settled answer.
    expect(fake.getExecuteMinTimestamps()[0]).toBe(11);
  });

  test("a settle failure degrades to the original capture rather than failing the tool", async () => {
    const timer = new FakeTimer();
    const fake = new FakeObserveScreen();
    fake.setFailureMode("execute", new Error("ctrlproxy read failed"));

    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(false);
    expect(outcome.observation).toBe(captured);
  });

  test("a cancelled request degrades to the original capture, never a tool error", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    controller.abort();
    const fake = new FakeObserveScreen();
    fake.setObserveResult(obs(AIRPLANE_ROW_INFLATED, 20));

    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    // The action already ran; turning its completed result into an error would
    // invite a client retry, i.e. a second tap.
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
      signal: controller.signal,
    });

    expect(outcome.settled).toBe(false);
    expect(outcome.observation).toBe(captured);
    expect(fake.getExecuteCallCount()).toBe(0);
  });
});

describe("settleEmbeddedObservationInResponse (#6866)", () => {
  function tapOnResponse(observation: ObserveResult) {
    return createStructuredToolResponse({ success: true, action: "tap", observation });
  }

  test("rewrites BOTH representations with the settled observation", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs(AIRPLANE_ROW_INFLATED, 20), obs(AIRPLANE_ROW_INFLATED, 30)]);

    const response = tapOnResponse(obs(AIRPLANE_ROW_HALF_INFLATED, 10));
    await settleEmbeddedObservationInResponse(response, {
      name: "tapOn",
      args: {},
      internal: false,
      createSettleObserve: () => settleFor(fake, timer),
    });

    const structured = response.structuredContent as Record<string, any>;
    expect(structured.observation.settled).toBe(true);
    const fromText = JSON.parse(response.content[0].text);
    expect(fromText.observation.settled).toBe(true);
    expect(fromText.observation.viewHierarchy.hierarchy.node.node.node.length).toBe(2);
  });

  test("stamps settled:false on a non-gated action without observing", async () => {
    const fake = new FakeObserveScreen();
    const response = tapOnResponse(obs(AIRPLANE_ROW_INFLATED, 10));
    await settleEmbeddedObservationInResponse(response, {
      name: "sendKeys",
      args: { commands: [{ action: "clear" }] },
      internal: false,
      createSettleObserve: () => settleFor(fake, new FakeTimer()),
    });

    expect((response.structuredContent as Record<string, any>).observation.settled).toBe(false);
    expect(fake.getExecuteCallCount()).toBe(0);
  });

  test("internal tool-to-tool calls are left alone", async () => {
    const fake = new FakeObserveScreen();
    const response = tapOnResponse(obs(AIRPLANE_ROW_HALF_INFLATED, 10));
    await settleEmbeddedObservationInResponse(response, {
      name: "tapOn",
      args: {},
      internal: true,
      createSettleObserve: () => settleFor(fake, new FakeTimer()),
    });

    expect((response.structuredContent as Record<string, any>).observation.settled).toBeUndefined();
    expect(fake.getExecuteCallCount()).toBe(0);
  });

  test("a failed action is not re-observed", async () => {
    const fake = new FakeObserveScreen();
    const response = createStructuredToolResponse({
      success: false,
      error: "element not found",
      observation: obs(AIRPLANE_ROW_HALF_INFLATED, 10),
    });
    await settleEmbeddedObservationInResponse(response, {
      name: "tapOn",
      args: {},
      internal: false,
      createSettleObserve: () => settleFor(fake, new FakeTimer()),
    });

    expect(fake.getExecuteCallCount()).toBe(0);
    // ...but the verdict is still stamped: the capture exists and was never
    // stability-checked, and the contract says every action observation carries
    // a boolean.
    expect((response.structuredContent as Record<string, any>).observation.settled).toBe(false);
    expect(JSON.parse(response.content[0].text).observation.settled).toBe(false);
  });

  test("a handler's own settled:true verdict is never downgraded", async () => {
    // `systemTray({action: "tap"})` already polls for a changed hierarchy that
    // stays structurally stable and publishes the verdict at the payload top
    // level. It is not one of the classified action tools, so the gate would
    // otherwise stamp `settled: false` onto the very capture that verdict
    // describes -- two contradictory answers in one response.
    const fake = new FakeObserveScreen();
    const response = createStructuredToolResponse({
      success: true,
      message: "Tapped notification",
      settled: true,
      observation: obs(AIRPLANE_ROW_INFLATED, 10),
    });
    await settleEmbeddedObservationInResponse(response, {
      name: "systemTray",
      args: { action: "tap" },
      internal: false,
      createSettleObserve: () => settleFor(fake, new FakeTimer()),
    });

    expect((response.structuredContent as Record<string, any>).observation.settled).toBe(true);
    expect(JSON.parse(response.content[0].text).observation.settled).toBe(true);
    expect(fake.getExecuteCallCount()).toBe(0);
  });

  test("a handler's own settled:false verdict is not promoted either", async () => {
    const fake = new FakeObserveScreen();
    const response = createStructuredToolResponse({
      success: true,
      message: "Tapped notification; effect not yet settled",
      settled: false,
      observation: obs(AIRPLANE_ROW_INFLATED, 10),
    });
    await settleEmbeddedObservationInResponse(response, {
      name: "systemTray",
      args: { action: "tap" },
      internal: false,
      createSettleObserve: () => settleFor(fake, new FakeTimer()),
    });

    expect((response.structuredContent as Record<string, any>).observation.settled).toBe(false);
  });

  test("a handler's own settled:true skips the navigation gate entirely", async () => {
    // `openLink`'s integrated `waitFor`/`settled` gate ALREADY proved this
    // capture stable. Running the navigation gate on top of it would spend a
    // second settle budget on a screen that is done moving and -- on a screen
    // that never reaches structural stability -- would time out, adopt a later
    // frame, and stamp `observation.settled: false` underneath the payload-level
    // `settled: true` the handler published. One response, two contradictory
    // verdicts. So the gate does not run at all.
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // A ticking clock: if the gate DID run it would never see two structurally
    // equal reads, time out, and adopt the newest frame.
    fake.setObserveResult((index) =>
      obs(
        {
          class: "android.widget.TextView",
          "resource-id": "android:id/clock",
          text: `0:0${index}`,
        },
        20 + index * 10,
      ),
    );

    const handlerObservation = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    const response = createStructuredToolResponse({
      success: true,
      settled: true,
      observation: handlerObservation,
    });
    await settleEmbeddedObservationInResponse(response, {
      name: "openLink",
      args: {},
      internal: false,
      createSettleObserve: () => settleFor(fake, timer),
    });

    const structured = response.structuredContent as Record<string, any>;
    expect(fake.getExecuteCallCount()).toBe(0);
    expect(structured.settled).toBe(true);
    expect(structured.observation.settled).toBe(true);
    // The handler's own capture is what is handed back, untouched.
    expect(structured.observation.viewHierarchy.hierarchy.node["resource-id"]).toBe(
      "android:id/list_container",
    );
    expect(JSON.parse(response.content[0].text).observation.settled).toBe(true);
  });

  test("no embedded observation is a no-op", async () => {
    const fake = new FakeObserveScreen();
    const response = createStructuredToolResponse({ success: true });
    await settleEmbeddedObservationInResponse(response, {
      name: "tapOn",
      args: {},
      internal: false,
      createSettleObserve: () => settleFor(fake, new FakeTimer()),
    });

    expect(response.structuredContent).toEqual({ success: true });
    expect(fake.getExecuteCallCount()).toBe(0);
  });

  test("no settle delegate (device unresolved) leaves the response untouched", async () => {
    const response = tapOnResponse(obs(AIRPLANE_ROW_HALF_INFLATED, 10));
    await settleEmbeddedObservationInResponse(response, {
      name: "tapOn",
      args: {},
      internal: false,
      createSettleObserve: () => undefined,
    });

    expect((response.structuredContent as Record<string, any>).observation.settled).toBeUndefined();
  });
});

describe("settleEmbeddedObservation adoption guard (#6866)", () => {
  test("a fallback capture OLDER than the action's own is never adopted", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // Every poll serves a pre-tap cache entry: older than the capture the action
    // already holds, so `pollObserveUntil` admits none of them and falls back to
    // the last raw read on timeout.
    fake.setObserveResult(obs(AIRPLANE_ROW_HALF_INFLATED, 50));

    const captured = obs(AIRPLANE_ROW_INFLATED, 100);
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(false);
    expect(outcome.observation).toBe(captured);
  });

  test("an explicitly stale fallback capture is never adopted", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // Newer by device clock, but ObserveScreen retracted its freshness (a
    // wrong-window capture, #5867). It is not evidence the gate may promote.
    fake.setObserveResult({
      ...obs(AIRPLANE_ROW_HALF_INFLATED, 200),
      freshness: { isFresh: false, category: "window_identity" },
    } as ObserveResult);

    const captured = obs(AIRPLANE_ROW_INFLATED, 100);
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(false);
    expect(outcome.observation).toBe(captured);
  });

  test("a trustworthy newer frame is still adopted on timeout, flagged unsettled", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // A ticking clock: never two structurally-equal reads, but every read is a
    // genuine post-action capture. The newest one beats the half-inflated tree
    // the action holds, so the gate hands it back — honestly unsettled.
    fake.setObserveResult((index) =>
      obs(
        {
          class: "android.widget.TextView",
          "resource-id": "android:id/clock",
          text: `0:0${index}`,
        },
        20 + index * 10,
      ),
    );

    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(false);
    expect(outcome.observation).not.toBe(captured);
    expect((outcome.observation.viewHierarchy!.hierarchy.node as any)["resource-id"]).toBe(
      "android:id/clock",
    );
  });
});

describe("settleEmbeddedObservation stale-state clearing (#6866)", () => {
  test("screen state the settled capture no longer reports does not survive", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // ObserveScreen re-derives these from EVERY hierarchy and writes `undefined`
    // when the destination has no focused node / no chooser — exactly the shape
    // the settle poll hands back here.
    const settledFrame = {
      ...obs(AIRPLANE_ROW_INFLATED, 20),
      focusedElement: undefined,
      accessibilityFocusedElement: undefined,
      intentChooserDetected: undefined,
      notificationPermissionDetected: undefined,
    } as ObserveResult;
    fake.setObserveSequence([settledFrame, { ...settledFrame, updatedAt: 30 } as ObserveResult]);

    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    (captured as any).focusedElement = { text: "Search", bounds: { left: 0, top: 0 } };
    (captured as any).accessibilityFocusedElement = { text: "Search" };
    (captured as any).intentChooserDetected = true;
    (captured as any).notificationPermissionDetected = true;
    (captured as any).error = "partial hierarchy";
    (captured as any).errors = [{ phase: "hierarchy", message: "partial hierarchy" }];
    // ...while genuinely action-authored metadata still has to survive.
    (captured as any).gfxMetrics = { totalFrames: 12 };

    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(true);
    expect("focusedElement" in outcome.observation).toBe(false);
    expect("accessibilityFocusedElement" in outcome.observation).toBe(false);
    expect("intentChooserDetected" in outcome.observation).toBe(false);
    expect("notificationPermissionDetected" in outcome.observation).toBe(false);
    expect("error" in outcome.observation).toBe(false);
    expect("errors" in outcome.observation).toBe(false);
    expect((outcome.observation as any).gfxMetrics).toEqual({ totalFrames: 12 });
  });

  test("no capture-derived field outside the action whitelist survives adoption", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // An iOS destination with no identity signals: ObserveScreen assigns
    // `screenIdentity` the value `undefined` rather than omitting it, and the
    // settle poll always passes `skipAccessibilityAudit: true`, so neither of
    // these is defined on the settled capture.
    const settledFrame = {
      ...obs(AIRPLANE_ROW_INFLATED, 20),
      screenIdentity: undefined,
    } as ObserveResult;
    fake.setObserveSequence([settledFrame, { ...settledFrame, updatedAt: 30 } as ObserveResult]);

    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    (captured as any).screenIdentity = {
      platform: "ios",
      source: "heuristic",
      confidence: "high",
      key: "origin-screen",
      components: {},
    };
    (captured as any).rawViewHierarchy = { xcuitest: "{}", source: "xcuitest" };
    (captured as any).observeScope = { mode: "scoped" };
    (captured as any).recompositionSummary = { total: 3 };
    // ...while genuinely action-authored metadata still has to survive.
    (captured as any).gfxMetrics = { totalFrames: 12 };
    (captured as any).selectedElements = [{ text: "Airplane mode" }];

    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(true);
    // A stale `screenIdentity` would let diff mode read a cross-screen
    // transition as same-screen.
    expect("screenIdentity" in outcome.observation).toBe(false);
    expect("rawViewHierarchy" in outcome.observation).toBe(false);
    expect("observeScope" in outcome.observation).toBe(false);
    expect("recompositionSummary" in outcome.observation).toBe(false);
    expect((outcome.observation as any).gfxMetrics).toEqual({ totalFrames: 12 });
    expect((outcome.observation as any).selectedElements).toEqual([{ text: "Airplane mode" }]);
  });
});

describe("settleEmbeddedObservation accessibility audit (#6890)", () => {
  /** The shape `AccessibilityAuditor.run` attaches, trimmed to what matters here. */
  const auditOfTheHalfInflatedTree = {
    screenId: "com.android.settings/.SubSettings#half",
    violations: [{ ruleId: "touch-target-size", elementId: "2f0e3dad" }],
    summary: { passed: false, bySeverity: { error: 1, warning: 0 } },
  };

  test("an adopted settled capture never carries the audit of the capture it replaced", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // The settle poll always passes `skipAccessibilityAudit: true`, so no poll
    // result ever carries an audit of its own.
    fake.setObserveSequence([
      obs(AIRPLANE_ROW_INFLATED, 20),
      obs(AIRPLANE_ROW_INFLATED, 30),
      obs(AIRPLANE_ROW_INFLATED, 40),
    ]);

    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    (captured as any).accessibilityAudit = auditOfTheHalfInflatedTree;

    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(true);
    // Its elements, violations, fingerprint and screen id all describe the
    // half-inflated tree that is no longer being returned.
    expect("accessibilityAudit" in outcome.observation).toBe(false);
    // ...and its absence is explained rather than silent: an audit the caller
    // explicitly asked for must not simply evaporate.
    expect(outcome.observation.accessibilityAuditSkipped).toBe("settled_capture_adopted");
  });

  test("an audit survives when the settled capture is NOT adopted", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // Every poll serves a pre-action cache entry, so nothing is adoptable and
    // the action's own capture — the one the audit describes — is handed back.
    fake.setObserveResult(obs(AIRPLANE_ROW_HALF_INFLATED, 5));

    const captured = obs(AIRPLANE_ROW_INFLATED, 100);
    (captured as any).accessibilityAudit = auditOfTheHalfInflatedTree;

    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.observation).toBe(captured);
    expect(outcome.observation.accessibilityAudit).toEqual(auditOfTheHalfInflatedTree as any);
    expect(outcome.observation.accessibilityAuditSkipped).toBeUndefined();
  });

  test("no marker is added when no audit was requested", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([
      obs(AIRPLANE_ROW_INFLATED, 20),
      obs(AIRPLANE_ROW_INFLATED, 30),
      obs(AIRPLANE_ROW_INFLATED, 40),
    ]);

    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: obs(AIRPLANE_ROW_HALF_INFLATED, 10),
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(true);
    expect("accessibilityAuditSkipped" in outcome.observation).toBe(false);
  });
});

describe("settle poll cost (#6890 review)", () => {
  test("every poll skips the performance audit, not just the screenshot and a11y audit", async () => {
    // The performance audit drives up to three synthetic touches plus ADB and
    // DB work that honours none of this gate's one-second budget. Running it
    // per poll on the hot path of every navigation action would perturb the
    // very screen being settled and corrupt the measurement.
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs(AIRPLANE_ROW_INFLATED, 20), obs(AIRPLANE_ROW_INFLATED, 30)]);

    await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: obs(AIRPLANE_ROW_HALF_INFLATED, 10),
      settleObserve: settleFor(fake, timer),
    });

    const options = fake.getExecuteOptions();
    expect(options.length).toBeGreaterThan(0);
    expect(options.every((option) => option.skipPerformanceAudit === true)).toBe(true);
    expect(options.every((option) => option.skipRecompositionTracking === true)).toBe(true);
    expect(options.every((option) => option.skipScreenshot === true)).toBe(true);
    expect(options.every((option) => option.skipAccessibilityAudit === true)).toBe(true);
    expect(fake.getProcessRecompositionCallCount()).toBe(1);
  });
});

describe("handler settle verdicts skip the generic gate (#6890 review)", () => {
  test("a handler's own settled:false also skips the navigation gate", async () => {
    // `openLink` runs its own integrated `waitFor` settle and publishes the
    // verdict at the payload top level. When that wait TIMES OUT it publishes
    // `settled: false` -- still a verdict about this capture. Running the
    // generic gate on top of it would re-observe, possibly adopt a later frame,
    // and stamp `observation.settled: true` underneath the payload-level
    // `settled: false`, with the handler's wait metadata now describing a
    // capture that is no longer there.
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs(AIRPLANE_ROW_INFLATED, 20), obs(AIRPLANE_ROW_INFLATED, 30)]);

    const handlerObservation = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    const response = createStructuredToolResponse({
      success: true,
      settled: false,
      awaitTimeout: true,
      observation: handlerObservation,
    });
    await settleEmbeddedObservationInResponse(response, {
      name: "openLink",
      args: {},
      internal: false,
      createSettleObserve: () => settleFor(fake, timer),
    });

    const structured = response.structuredContent as Record<string, any>;
    expect(fake.getExecuteCallCount()).toBe(0);
    expect(structured.settled).toBe(false);
    expect(structured.observation.settled).toBe(false);
    // The handler's own capture is what is handed back, untouched.
    expect(structured.observation.viewHierarchy.hierarchy.node["resource-id"]).toBe(
      "android:id/list_container",
    );
    expect(JSON.parse(response.content[0].text).observation.settled).toBe(false);
  });

  test("a handler verdict is still absent when the payload's settled is not a boolean", async () => {
    // Only a real boolean is a verdict. A payload that carries no `settled`
    // (every ordinary action tool) must still be gated.
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs(AIRPLANE_ROW_INFLATED, 20), obs(AIRPLANE_ROW_INFLATED, 30)]);

    const response = createStructuredToolResponse({
      success: true,
      action: "tap",
      observation: obs(AIRPLANE_ROW_HALF_INFLATED, 10),
    });
    await settleEmbeddedObservationInResponse(response, {
      name: "tapOn",
      args: {},
      internal: false,
      createSettleObserve: () => settleFor(fake, timer),
    });

    expect(fake.getExecuteCallCount()).toBeGreaterThan(0);
    expect((response.structuredContent as Record<string, any>).observation.settled).toBe(true);
  });
});
