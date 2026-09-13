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
      name: "clearText",
      args: {},
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
