import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Rotate } from "../../../src/features/action/Rotate";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import type { CtrlProxyRotateResult } from "../../../src/features/observe/ios";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";

describe("iOS observed rotation verification (#8778)", () => {
  let rotate: Rotate;
  let runner: FakeIOSCtrlProxy;
  let observe: FakeObserveScreen;
  let instanceSpy: ReturnType<typeof spyOn>;

  const createObserveResult = (rotation?: number, knownSize = true): ObserveResult => ({
    timestamp: 1000,
    rotation,
    screenSize: knownSize
      ? rotation === 1 || rotation === 3
        ? { width: 874, height: 402 }
        : { width: 402, height: 874 }
      : { width: 0, height: 0 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: { hierarchy: {} },
  });
  const runnerResult = (overrides: Partial<CtrlProxyRotateResult> = {}): CtrlProxyRotateResult => ({
    success: true,
    totalTimeMs: 1,
    value: 1,
    rotationPerformed: true,
    previousOrientation: "portrait_upside_down",
    currentOrientation: "landscape_left",
    ...overrides,
  });

  beforeEach(() => {
    runner = new FakeIOSCtrlProxy();
    observe = new FakeObserveScreen();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const device: BootedDevice = {
      name: "iPhone",
      deviceId: "ios-rotate-verification",
      platform: "ios",
      source: "local",
    };
    // Only requestRotate is reachable at this injected seam; no client I/O runs.
    const client = Object.assign(
      Object.create(IOSCtrlProxyClient.prototype) as IOSCtrlProxyClient,
      {
        requestRotate: (...args: Parameters<IOSCtrlProxyClient["requestRotate"]>) =>
          runner.requestRotate(...args),
      },
    );
    instanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(client);
    rotate = new Rotate(device, new FakeAdbExecutor(), timer);
    Object.assign(rotate, {
      observeScreen: observe,
      awaitIdle: new FakeAwaitIdle(),
      window: new FakeWindow(),
    });
  });
  afterEach(() => {
    instanceSpy.mockRestore();
  });

  test("reconciles runner size failure when observed portrait becomes landscape", async () => {
    const error = "Rotation is not supported on this display (the screen size did not change)";
    spyOn(runner, "requestRotate").mockResolvedValue(
      runnerResult({ success: false, error, rotationPerformed: false }),
    );
    observe.setObserveSequence([createObserveResult(0), createObserveResult(1)]);
    const result = await rotate.execute("landscape");
    expect(result.success).toBe(true);
    expect(result.rotationPerformed).toBe(true);
    expect(result.previousOrientation).toBe("portrait");
    expect(result.currentOrientation).toBe("landscape");
    expect(result.observation?.rotation).toBe(1);
    expect(result.warning).toContain(error);
    expect(result.error).toBeUndefined();
    expect(result.message).toContain("portrait to landscape");
  });

  test("rejects runner portrait no-op while observed display stays landscape", async () => {
    spyOn(runner, "requestRotate").mockResolvedValue(
      runnerResult({
        value: 0,
        rotationPerformed: false,
        previousOrientation: "landscape_left",
        currentOrientation: "portrait",
      }),
    );
    observe.setObserveSequence([createObserveResult(1), createObserveResult(1)]);
    const result = await rotate.execute("portrait");
    expect(result.success).toBe(false);
    expect(result.rotationPerformed).toBe(false);
    expect(result.currentOrientation).toBe("landscape");
    expect(result.previousOrientation).toBe("landscape");
    expect(result.error).toContain("landscape");
    expect(result.error).toContain("already in portrait");
    expect(result.message).not.toContain("already in portrait");
    expect(result.observation?.rotation).toBe(1);
  });

  test("keeps a successful portrait no-op and prefers observed portrait over runner vocabulary", async () => {
    spyOn(runner, "requestRotate").mockResolvedValue(
      runnerResult({
        value: 0,
        rotationPerformed: false,
        previousOrientation: "landscape_left",
        currentOrientation: "portrait",
      }),
    );
    observe.setObserveSequence([createObserveResult(0), createObserveResult(2)]);
    const result = await rotate.execute("portrait");
    expect(result.success).toBe(true);
    expect(result.rotationPerformed).toBe(false);
    expect(result.previousOrientation).toBe("portrait");
    expect(result.currentOrientation).toBe("portrait");
    expect(result.message).toBe("Device is already in portrait orientation");
  });

  test("keeps a performed landscape rotation with normalized orientations", async () => {
    spyOn(runner, "requestRotate").mockResolvedValue(runnerResult());
    observe.setObserveSequence([createObserveResult(0), createObserveResult(3)]);
    const result = await rotate.execute("landscape");
    expect(result.success).toBe(true);
    expect(result.rotationPerformed).toBe(true);
    expect(result.previousOrientation).toBe("portrait");
    expect(result.currentOrientation).toBe("landscape");
    expect(result.observation?.rotation).toBe(3);
  });

  test("trusts runner success when observations are unknown and normalizes its vocabulary", async () => {
    spyOn(runner, "requestRotate").mockResolvedValue(runnerResult());
    observe.setObserveSequence([
      createObserveResult(undefined, false),
      createObserveResult(undefined, false),
    ]);
    const result = await rotate.execute("landscape");
    expect(result.success).toBe(true);
    expect(result.rotationPerformed).toBe(true);
    expect(result.previousOrientation).toBe("portrait");
    expect(result.currentOrientation).toBe("landscape");
  });

  test("preserves runner failure without proof of an observed orientation change", async () => {
    const error = "Rotation is not supported on this display (the screen size did not change)";
    spyOn(runner, "requestRotate").mockResolvedValue(
      runnerResult({ success: false, error, rotationPerformed: false }),
    );
    for (const [before, after, previous, current] of [
      [createObserveResult(undefined, false), createObserveResult(1), "portrait", "landscape"],
      [createObserveResult(1), createObserveResult(1), "landscape", "landscape"],
      [createObserveResult(0), createObserveResult(undefined, false), "portrait", "landscape"],
    ] as const) {
      observe.setObserveResult((index) => (index % 2 === 0 ? before : after));
      const result = await rotate.execute("landscape");
      expect(result.success).toBe(false);
      expect(result.rotationPerformed).toBe(false);
      expect(result.error).toBe(error);
      expect(result.warning).toBeUndefined();
      expect(result.previousOrientation).toBe(previous);
      expect(result.currentOrientation).toBe(current);
    }
  });

  test("rejects a performed runner claim when the observed display remains portrait", async () => {
    spyOn(runner, "requestRotate").mockResolvedValue(runnerResult());
    observe.setObserveSequence([createObserveResult(0), createObserveResult(0)]);
    const result = await rotate.execute("landscape");
    expect(result.success).toBe(false);
    expect(result.rotationPerformed).toBe(false);
    expect(result.currentOrientation).toBe("portrait");
    expect(result.previousOrientation).toBe("portrait");
    expect(result.error).toContain("still portrait");
    expect(result.error).toContain("completed rotation to landscape");
  });

  test("accepts observed landscape despite unknown runner previous orientation and unchanged size", async () => {
    spyOn(runner, "requestRotate").mockResolvedValue(
      runnerResult({ previousOrientation: "unknown" }),
    );
    observe.setObserveSequence([createObserveResult(1), createObserveResult(1)]);
    const result = await rotate.execute("landscape");
    expect(result.success).toBe(true);
    expect(result.rotationPerformed).toBe(true);
    expect(result.currentOrientation).toBe("landscape");
    expect(result.previousOrientation).toBe("landscape");
    expect(result.error).toBeUndefined();
  });

  test("normalizes runner orientation vocabulary with unknown observations", async () => {
    observe.setObserveResult(() => createObserveResult(undefined, false));
    for (const [raw, normalized] of [
      ["landscape_left", "landscape"],
      ["landscape_right", "landscape"],
      ["landscape", "landscape"],
      ["portrait_upside_down", "portrait"],
      ["portrait", "portrait"],
      ["", "unknown"],
      ["face_up", "unknown"],
    ]) {
      spyOn(runner, "requestRotate").mockResolvedValue(
        runnerResult({ previousOrientation: raw, currentOrientation: raw }),
      );
      const result = await rotate.execute("landscape");
      expect(result.currentOrientation).toBe(normalized);
      expect(result.previousOrientation).toBe(normalized);
    }
  });
});
