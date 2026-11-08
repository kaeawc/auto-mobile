import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { IosDisplayPixelProbe } from "../../../src/features/action/iosRotateDisplayProbe";
import { Rotate } from "../../../src/features/action/Rotate";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import type { CtrlProxyRotateResult } from "../../../src/features/observe/ios";
import type { BootedDevice, ObserveResult, RotateResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { spyOnIosClientInstance } from "../../helpers/iosCtrlProxyClientSpies";

describe("iOS observed rotation verification (#8778)", () => {
  let rotate: Rotate;
  let runner: FakeIOSCtrlProxy;
  let observe: FakeObserveScreen;
  let timer: FakeTimer;
  let pixelReads: Array<string | undefined>;
  let pixelSizes: Array<{ width: number; height: number } | undefined>;
  let recoveryStarts: number;
  let recoveryWaits: Array<[number, AbortSignal | undefined]>;
  let recoveryError: Error | undefined;
  let recoveryOutcome: () => "recovered" | "timed_out";
  let instanceSpy: ReturnType<typeof spyOn>;

  test("restore state is unobservable and never reads defaulted Android orientation on iOS", async () => {
    const adb = new FakeAdbExecutor();
    const iosRotate = new Rotate(
      { deviceId: "ios-restore", name: "iPhone", platform: "ios" },
      { adb, timer: new FakeTimer() },
    );
    await expect(iosRotate.getRestoreState()).rejects.toThrow(
      "iOS rotation restore state is unobservable",
    );
    expect(adb.getCommandCalls()).toEqual([]);
  });

  const createObserveResult = (rotation?: number, knownSize = true): ObserveResult => ({
    updatedAt: 1000,
    observationId: "test-observation",
    display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
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
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    pixelReads = [];
    pixelSizes = [];
    recoveryStarts = 0;
    recoveryWaits = [];
    recoveryError = undefined;
    recoveryOutcome = () => "recovered";
    const probe: IosDisplayPixelProbe = {
      async readPixelSize(_deviceId, displayKey) {
        pixelReads.push(displayKey);
        return pixelSizes.shift();
      },
    };
    const device: BootedDevice = {
      name: "iPhone",
      deviceId: "ios-rotate-verification",
      platform: "ios",
      source: "local",
    };
    // Rotation and recovery use fakes at this seam; no client I/O runs.
    const client = Object.assign(Object.create(IOSCtrlProxyClient.prototype), {
      ensureRecoveryStarted: () => {
        recoveryStarts++;
      },
      awaitRecovery: async (budget: number, signal?: AbortSignal) => {
        recoveryWaits.push([budget, signal]);
        if (recoveryError) {
          throw recoveryError;
        }
        return recoveryOutcome();
      },
      requestRotate: (...args: Parameters<IOSCtrlProxyClient["requestRotate"]>) =>
        runner.requestRotate(...args),
    });
    instanceSpy = spyOnIosClientInstance(client);
    rotate = new Rotate(device, {
      adb: new FakeAdbExecutor(),
      timer,
      options: { iosDisplayPixelProbe: probe },
    });
    Object.assign(rotate, {
      observeScreen: observe,
      awaitIdle: new FakeAwaitIdle(),
      window: new FakeWindow(),
    });
  });
  afterEach(() => {
    instanceSpy.mockRestore();
  });

  test.each([false, true])(
    "timeout recovers without sending restore (recovery throws: %p)",
    async (throws) => {
      recoveryError = throws ? new Error("recovery budget exhausted") : undefined;
      const call = spyOn(runner, "requestRotate").mockResolvedValue(
        runnerResult({
          success: false,
          timedOut: true,
          error: "Rotate timed out after 5000ms",
          rotationPerformed: false,
        }),
      );
      observe.setObserveSequence([createObserveResult(1), createObserveResult(0)]);
      const result = await rotate.execute("portrait");
      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");
      expect(result.warning).toContain(
        throws ? "recovery budget exhausted" : "recovered (runner restarted)",
      );
      expect(call).toHaveBeenCalledTimes(1);
      expect(recoveryStarts).toBe(1);
      expect(recoveryWaits).toEqual([[IOSCtrlProxyClient.OBSERVE_RECOVERY_WAIT_MS, undefined]]);
      expect(pixelReads).toEqual([]);
    },
  );

  test.each([true, false])(
    "rechecks independent display pixels after animation (agrees: %p)",
    async (agrees) => {
      const before = {
        ...createObserveResult(1),
        screenSize: { width: 951, height: 669 },
        display: {
          key: "primary-1",
          role: "inner" as const,
          posture: "unknown" as const,
          generation: 0,
        },
      };
      const after = { ...before, rotation: 0, screenSize: { width: 669, height: 951 } };
      observe.setObserveSequence([before, after]);
      const call = spyOn(runner, "requestRotate").mockResolvedValue(
        runnerResult({
          value: 0,
          currentOrientation: "portrait",
          previousOrientation: "landscape",
        }),
      );
      pixelSizes = [
        { width: 2853, height: 2007 },
        agrees ? { width: 2007, height: 2853 } : { width: 2853, height: 2007 },
      ];
      const result = await rotate.execute("portrait");
      expect(result.success).toBe(agrees);
      expect(pixelReads).toEqual(["primary-1", "primary-1"]);
      expect(timer.getSleepHistory()).toContain(200);
      expect(call.mock.calls.map((c) => c[0])).toEqual(
        agrees ? ["portrait"] : ["portrait", "landscape"],
      );
      if (!agrees) {
        expect(result.error).toContain("inner panel");
        expect(result.observation).toBeUndefined();
      }
    },
  );

  const timedOutRotate = () =>
    runnerResult({
      success: false,
      timedOut: true,
      error: "Rotate timed out after 5000ms",
      rotationPerformed: false,
    });

  test("timeout starts recovery before the post-action observation", async () => {
    spyOn(runner, "requestRotate").mockResolvedValue(timedOutRotate());
    const startsAtObserve: number[] = [];
    observe.setObserveResult((index) => {
      startsAtObserve.push(recoveryStarts);
      return createObserveResult(index === 0 ? 1 : 0);
    });
    const result = await rotate.execute("portrait");
    expect(result.success).toBe(false);
    expect(startsAtObserve[0]).toBe(0);
    expect(startsAtObserve.slice(1).every((starts) => starts === 1)).toBe(true);
    expect(startsAtObserve.length).toBeGreaterThan(1);
    expect(recoveryStarts).toBe(1);
  });

  test("cancellation during timeout recovery throws instead of returning a warning", async () => {
    spyOn(runner, "requestRotate").mockResolvedValue(timedOutRotate());
    observe.setObserveSequence([createObserveResult(1), createObserveResult(0)]);
    const controller = new AbortController();
    recoveryOutcome = () => {
      controller.abort();
      return "timed_out";
    };
    await expect(rotate.execute("portrait", { signal: controller.signal })).rejects.toThrow();
    expect(recoveryWaits).toHaveLength(1);
  });

  test("an indeterminate pixel retry keeps the first contradictory read", async () => {
    const before = { ...createObserveResult(1), screenSize: { width: 951, height: 669 } };
    observe.setObserveSequence([before, { ...before, rotation: 0 }]);
    const call = spyOn(runner, "requestRotate").mockResolvedValue(
      runnerResult({ value: 0, currentOrientation: "portrait", previousOrientation: "landscape" }),
    );
    pixelSizes = [{ width: 2853, height: 2007 }, undefined];
    const result = await rotate.execute("portrait");
    expect(result.success).toBe(false);
    expect(result.currentOrientation).toBe("landscape");
    expect(call.mock.calls.map((c) => c[0])).toEqual(["portrait", "landscape"]);
  });

  test("a timed-out restore after a pixel contradiction recovers the runner", async () => {
    const before = { ...createObserveResult(1), screenSize: { width: 951, height: 669 } };
    observe.setObserveSequence([before, { ...before, rotation: 0 }]);
    const call = spyOn(runner, "requestRotate")
      .mockResolvedValueOnce(
        runnerResult({
          value: 0,
          currentOrientation: "portrait",
          previousOrientation: "landscape",
        }),
      )
      .mockResolvedValueOnce(timedOutRotate());
    pixelSizes = [
      { width: 2853, height: 2007 },
      { width: 2853, height: 2007 },
    ];
    const result = await rotate.execute("portrait");
    expect(result.success).toBe(false);
    expect(call.mock.calls.map((c) => c[0])).toEqual(["portrait", "landscape"]);
    expect(recoveryStarts).toBe(1);
    expect(recoveryWaits).toEqual([[IOSCtrlProxyClient.OBSERVE_RECOVERY_WAIT_MS, undefined]]);
    expect(result.warning).toContain("could not be restored to landscape");
    expect(result.warning).toContain("rotate restore timeout: recovered (runner restarted)");
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

  test("restores the prior orientation when a rotate on the home screen fails (item6-rotate-residue)", async () => {
    const error = "Rotation is not supported on this display (the screen size did not change)";
    const spy = spyOn(runner, "requestRotate")
      .mockResolvedValueOnce(runnerResult({ success: false, error, rotationPerformed: false }))
      .mockResolvedValueOnce(runnerResult({ value: 0, currentOrientation: "portrait" }));
    observe.setObserveSequence([createObserveResult(0), createObserveResult(0)]);
    const result = await rotate.execute("landscape");
    expect(result.success).toBe(false);
    expect(spy.mock.calls.map((call) => call[0])).toEqual(["landscape", "portrait"]);
    expect(result.warning).toBeUndefined();
  });

  test("does not restore a refused landscape rotate to stale portrait rotation (#17101)", async () => {
    const envelope = JSON.parse(
      readFileSync("test/fixtures/ios-rotate/observe-duo-inner-opened-playground.json", "utf8"),
    ) as { content: Array<{ text: string }> };
    const captured = JSON.parse(envelope.content[0]!.text) as {
      rotation: number;
      screenSize: { width: number; height: number };
    };
    observe.setObserveSequence([
      { ...createObserveResult(captured.rotation), screenSize: captured.screenSize },
    ]);
    const spy = spyOn(runner, "requestRotate").mockResolvedValue(
      runnerResult({
        success: false,
        rotationPerformed: false,
        error: "Rotation is not supported on this display (the screen size did not change)",
        value: 1,
        previousOrientation: "portrait",
        currentOrientation: "portrait",
      }),
    );
    const result = await rotate.execute("landscape");
    expect(result.success).toBe(false);
    expect(spy.mock.calls.map((call) => call[0])).toEqual(["landscape"]);
    expect(result.warning).toBeUndefined();
  });

  test("restores drawn landscape after a refused portrait rotate (#17101)", async () => {
    const envelope = JSON.parse(
      readFileSync("test/fixtures/ios-rotate/observe-duo-inner-opened-playground.json", "utf8"),
    ) as { content: Array<{ text: string }> };
    const captured = JSON.parse(envelope.content[0]!.text) as {
      rotation: number;
      screenSize: { width: number; height: number };
    };
    observe.setObserveSequence([
      { ...createObserveResult(captured.rotation), screenSize: captured.screenSize },
    ]);
    const spy = spyOn(runner, "requestRotate")
      .mockResolvedValueOnce(
        runnerResult({
          success: false,
          rotationPerformed: false,
          error: "Rotation is not supported on this display (the screen size did not change)",
          value: 0,
          previousOrientation: "portrait",
          currentOrientation: "portrait",
        }),
      )
      .mockResolvedValueOnce(runnerResult());
    const result = await rotate.execute("portrait");
    expect(result.success).toBe(false);
    expect(spy.mock.calls.map((call) => call[0])).toEqual(["portrait", "landscape"]);
  });

  test("accepts the daemon restore request shape after a failed landscape rotate", async () => {
    spyOn(runner, "requestRotate").mockResolvedValue(
      runnerResult({
        value: 0,
        rotationPerformed: true,
        previousOrientation: "portrait",
        currentOrientation: "portrait",
      }),
    );
    observe.setObserveSequence([createObserveResult(0), createObserveResult(0)]);
    const result = await rotate.execute("portrait");
    expect(result.success).toBe(true);
    expect(result.rotationPerformed).toBe(true);
    expect(result.previousOrientation).toBe("portrait");
    expect(result.currentOrientation).toBe("portrait");
    expect(result.error).toBeUndefined();
  });

  test("restores landscape after a refused portrait rotation with unchanged captured size", async () => {
    const envelope = JSON.parse(
      readFileSync(
        "test/fixtures/ios-rotate/rotate-duo-inner-portrait-unchanged-size-warned.json",
        "utf8",
      ),
    ) as { content: Array<{ text: string }> };
    const captured = JSON.parse(envelope.content[0]!.text) as RotateResult;
    const after = {
      ...createObserveResult(captured.observation!.rotation),
      screenSize: captured.observation!.screenSize,
    };
    const spy = spyOn(runner, "requestRotate")
      .mockResolvedValueOnce(
        runnerResult({
          success: false,
          rotationPerformed: false,
          error: "Rotation is not supported on this display (the screen size did not change)",
          value: 0,
          previousOrientation: "landscape",
          currentOrientation: "portrait",
        }),
      )
      .mockResolvedValueOnce(runnerResult());
    observe.setObserveSequence([{ ...after, rotation: 1 }, after]);
    const result = await rotate.execute("portrait");
    expect(result.success).toBe(false);
    expect(result.rotationPerformed).toBe(false);
    expect(result.message).toBe("Failed to rotate to portrait; the screen size did not change.");
    expect(spy.mock.calls.map((call) => call[0])).toEqual(["portrait", "landscape"]);
  });

  test("surfaces cancellation that arrives during the orientation restore", async () => {
    const controller = new AbortController();
    const spy = spyOn(runner, "requestRotate")
      .mockResolvedValueOnce(
        runnerResult({ success: false, error: "no", rotationPerformed: false }),
      )
      .mockImplementationOnce(async () => {
        controller.abort();
        return runnerResult({ value: 0, currentOrientation: "portrait" });
      });
    observe.setObserveSequence([createObserveResult(0), createObserveResult(0)]);
    await expect(rotate.execute("landscape", { signal: controller.signal })).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("warns when the orientation restore itself fails", async () => {
    spyOn(runner, "requestRotate")
      .mockResolvedValueOnce(
        runnerResult({ success: false, error: "no", rotationPerformed: false }),
      )
      .mockRejectedValueOnce(new Error("runner gone"));
    observe.setObserveSequence([createObserveResult(0), createObserveResult(0)]);
    const result = await rotate.execute("landscape");
    expect(result.success).toBe(false);
    expect(result.warning).toContain("could not be restored to portrait");
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
    spyOn(runner, "requestRotate").mockImplementation(async (orientation) =>
      orientation === "portrait"
        ? runnerResult({ value: 0, currentOrientation: "portrait" })
        : runnerResult({ success: false, error, rotationPerformed: false }),
    );
    for (const [before, after, previous, current] of [
      [createObserveResult(undefined, false), createObserveResult(1), "portrait", "landscape"],
      [createObserveResult(1), createObserveResult(1), "landscape", "landscape"],
      [createObserveResult(0), createObserveResult(undefined, false), "portrait", "landscape"],
    ] as const) {
      // Start each case with a cold cache: a cache read replays the last execute, so the
      // previous case's "after" must not stand in for this case's "before".
      observe.clearHistory();
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
