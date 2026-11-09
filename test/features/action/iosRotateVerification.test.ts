import { SimulatorIosDisplayPixelProbe } from "../../../src/features/action/iosRotateDisplayProbe";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  reconcileIosRotationWithDisplayRead,
  normalizeIosOrientation,
  observedIosOrientation,
  restoreTargetIosOrientation,
  verifyIosRotation,
} from "../../../src/features/action/iosRotateVerification";
import type { ObserveResult, RotateResult } from "../../../src/models";

type FixtureEnvelope = { content: Array<{ text: string }> };
type FixtureObservation = { rotation: number; screenSize: { width: number; height: number } };
type FixtureRotation = {
  observation: FixtureObservation;
  success: boolean;
  orientation: string;
  value: number;
  currentOrientation: string;
  previousOrientation: string;
  rotationPerformed: boolean;
  message: string;
};

const fixtureText = (path: string): string => {
  const fixture = JSON.parse(readFileSync(path, "utf8")) as FixtureEnvelope;
  return fixture.content[0]!.text;
};

const fixtureObservation = (fixture: FixtureObservation): ObserveResult =>
  observation(fixture.rotation, fixture.screenSize.width, fixture.screenSize.height);

const duoPrevious = (): ObserveResult => {
  const fixture = JSON.parse(
    fixtureText("test/fixtures/ios-rotate/observe-duo-inner-opened-playground.json"),
  ) as FixtureObservation;
  return fixtureObservation(fixture);
};

const duoRotation = (
  path = "test/fixtures/ios-rotate/rotate-duo-inner-landscape-unchanged-size.json",
): RotateResult => {
  const fixture = JSON.parse(fixtureText(path)) as FixtureRotation;
  return {
    ...fixture,
    observation: fixtureObservation(fixture.observation),
  };
};

const observation = (rotation?: number, width = 402, height = 874): ObserveResult => ({
  updatedAt: 1000,
  observationId: "test-observation",
  display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
  rotation,
  screenSize: { width, height },
  systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
});

describe("iOS runner refusal screen-size checks (#17101)", () => {
  const runnerRefusal = (): RotateResult => ({
    ...duoRotation("test/fixtures/ios-rotate/rotate-duo-inner-portrait-unchanged-size-warned.json"),
    // The capture is the public response after verification promoted the runner refusal.
    success: false,
    rotationPerformed: false,
    error: "Rotation is not supported on this display (the screen size did not change)",
    warning: undefined,
    message: undefined,
  });
  const previousLandscape = (): ObserveResult => ({ ...duoPrevious(), rotation: 1 });

  test("rejects the captured portrait refusal when only the observed rotation changes", () => {
    const result = verifyIosRotation(runnerRefusal(), "portrait", previousLandscape());
    expect(result.success).toBe(false);
    expect(result.rotationPerformed).toBe(false);
    expect(result.error).toBe(
      "Rotation is not supported on this display (the screen size did not change). The runner reported a rotation but the screen size is unchanged.",
    );
    expect(result.message).toBe("Failed to rotate to portrait; the screen size did not change.");
  });

  test("the refusal keeps the held landscape orientation instead of the runner's transient portrait", () => {
    const result = verifyIosRotation(runnerRefusal(), "portrait", previousLandscape());
    expect(result.observation?.rotation).toBe(1);
    expect(result.currentOrientation).toBe("landscape");
  });

  test("clears the transient rotation when the previous observation has none", () => {
    const previous = { ...previousLandscape(), rotation: undefined };
    const result = verifyIosRotation(runnerRefusal(), "portrait", previous);
    expect(result.observation?.rotation).toBeUndefined();
    expect(result.currentOrientation).toBe("landscape");
  });

  test("a refusal observed on a different display keeps its own rotation", () => {
    const refusal = runnerRefusal();
    const onOtherDisplay = {
      ...refusal,
      observation: {
        ...refusal.observation!,
        display: { ...refusal.observation!.display, key: "primary" },
      },
    };
    const result = verifyIosRotation(onOtherDisplay, "portrait", previousLandscape());
    expect(result.observation?.rotation).toBe(refusal.observation?.rotation);
    expect(result.currentOrientation).toBe(onOtherDisplay.currentOrientation);
  });

  test("reconciles the same refusal when the observed screen size changes", () => {
    const refusal = runnerRefusal();
    const result = verifyIosRotation(
      {
        ...refusal,
        observation: { ...refusal.observation!, screenSize: { width: 669, height: 951 } },
      },
      "portrait",
      previousLandscape(),
    );
    expect(result.success).toBe(true);
    expect(result.rotationPerformed).toBe(true);
    expect(result.warning).toContain(refusal.error!);
    expect(result.error).toBeUndefined();
  });

  test("preserves a cover-panel refusal when the observed rotation does not change", () => {
    const refusal = runnerRefusal();
    const result = verifyIosRotation(refusal, "portrait", duoPrevious());
    expect(result).toEqual({ ...refusal, previousOrientation: "portrait" });
  });

  test("keeps refusal reconciliation when either observation lacks a positive size", () => {
    for (const missingBefore of [true, false]) {
      const refusal = runnerRefusal();
      const previous = previousLandscape();
      if (missingBefore) {
        previous.screenSize.width = 0;
      } else {
        refusal.observation!.screenSize.width = 0;
      }
      const result = verifyIosRotation(refusal, "portrait", previous);
      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      expect(result.warning).toContain(refusal.error!);
    }
  });
});

describe("iOS rotation verification vocabulary (#8778)", () => {
  test("normalizes cardinal runner strings and treats unrecognized values as unknown", () => {
    for (const [raw, expected] of [
      ["landscape_left", "landscape"],
      ["landscape_right", "landscape"],
      ["landscape", "landscape"],
      ["portrait_upside_down", "portrait"],
      ["portrait", "portrait"],
      ["", "unknown"],
      ["face_up", "unknown"],
      [undefined, "unknown"],
    ]) {
      expect<unknown>(normalizeIosOrientation(raw)).toBe(expected);
    }
  });
  test("prefers cardinal observation rotation even when dimensions disagree", () => {
    expect(observedIosOrientation(observation(0, 874, 402))).toBe("portrait");
    expect(observedIosOrientation(observation(2, 874, 402))).toBe("portrait");
    expect(observedIosOrientation(observation(1))).toBe("landscape");
    expect(observedIosOrientation(observation(3))).toBe("landscape");
  });
  test("uses the observe size fallback only without cardinal rotation", () => {
    expect(observedIosOrientation(observation())).toBe("portrait");
    expect(observedIosOrientation(observation(undefined, 874, 402))).toBe("landscape");
    expect(observedIosOrientation(observation(undefined, 402, 402))).toBe("landscape");
    expect(observedIosOrientation(observation(undefined, 0, 874))).toBe("unknown");
    expect(observedIosOrientation(observation(undefined, NaN, 874))).toBe("unknown");
    expect(observedIosOrientation(undefined)).toBe("unknown");
  });
});

describe("iOS runner rotation refusal display guidance", () => {
  const runnerError = "Rotation is not supported on this display (the screen size did not change)";
  const coverError =
    "Rotation is not supported on the cover panel (the screen size did not change). Open the device to its inner panel (unfold the hinge) and retry there, or keep the current orientation.";
  const runnerFailure = (): RotateResult => ({
    ...duoRotation(),
    success: false,
    rotationPerformed: false,
    error: runnerError,
    message: "Runner refusal message",
    observation: observation(0),
  });

  test("names the cover and inner panels and keeps generic wording otherwise", () => {
    const previous = observation(0);
    const cover = {
      ...previous,
      display: { ...previous.display, role: "cover" as const },
    };
    const inner = {
      ...previous,
      display: { ...previous.display, role: "inner" as const },
    };

    const coverResult = verifyIosRotation(runnerFailure(), "landscape", cover);
    expect(coverResult).toMatchObject({
      success: false,
      rotationPerformed: false,
      error: coverError,
      message: "Runner refusal message",
    });
    expect(verifyIosRotation(runnerFailure(), "landscape", inner)).toMatchObject({
      success: false,
      rotationPerformed: false,
      error:
        "Rotation is not supported on the inner panel (the screen size did not change). Keep the current orientation.",
    });
    expect(verifyIosRotation(runnerFailure(), "landscape", undefined).error).toBe(runnerError);
  });

  test("an inner-panel rotation the display shows still wins over the runner refusal", () => {
    const inner = {
      ...observation(0),
      display: { ...observation(0).display, role: "inner" as const },
    };
    const result = verifyIosRotation(
      { ...runnerFailure(), observation: observation(1, 874, 402) },
      "landscape",
      inner,
    );
    expect(result).toMatchObject({ success: true, rotationPerformed: true, error: undefined });
    expect(result.warning).toContain(runnerError);
  });
});

describe("iOS rotation verification screen-size checks (#17047)", () => {
  test("names the cover and inner panels in an unchanged-size refusal (#17385)", () => {
    const previous = {
      ...duoPrevious(),
      display: { ...duoPrevious().display, role: "cover" as const },
    };
    const innerPrevious = { ...previous, display: { ...previous.display, role: "inner" as const } };
    const unknownPrevious = {
      ...previous,
      display: { ...previous.display, role: "unknown" as const },
    };
    const coverError =
      "Rotation is not supported on the cover panel (the screen size did not change). Open the device to its inner panel (unfold the hinge) and retry there, or keep the current orientation.";
    const genericError =
      "Rotation is not supported on this display (the screen size did not change). The runner reported a rotation but the screen size is unchanged.";

    const coverResult = verifyIosRotation(duoRotation(), "landscape", previous);
    expect(coverResult.error).toBe(coverError);
    expect(coverResult.message).toBe(
      "Failed to rotate to landscape; the screen size did not change.",
    );
    expect(coverResult.success).toBe(false);
    expect(coverResult.rotationPerformed).toBe(false);

    expect(verifyIosRotation(duoRotation(), "landscape", innerPrevious).error).toBe(
      "Rotation is not supported on the inner panel (the screen size did not change). The runner reported a rotation but the screen size is unchanged.",
    );
    expect(verifyIosRotation(duoRotation(), "landscape", unknownPrevious).error).toBe(genericError);
  });

  test("rejects a Duo landscape rotation when the panel size is unchanged", () => {
    const result = verifyIosRotation(duoRotation(), "landscape", duoPrevious());
    expect(result.success).toBe(false);
    expect(result.rotationPerformed).toBe(false);
    expect(result.error).toBe(
      "Rotation is not supported on this display (the screen size did not change). The runner reported a rotation but the screen size is unchanged.",
    );
    expect(result.message).toBe("Failed to rotate to landscape; the screen size did not change.");
  });

  // An unchanged size is evidence of a refusal only on the same display: a rotation that
  // succeeded while the target display changed must not be reported as unsupported (#17346).
  test("accepts a Duo landscape rotation observed on a different display", () => {
    const rotation = duoRotation();
    const onOtherDisplay = {
      ...rotation,
      observation: {
        ...rotation.observation!,
        display: { ...rotation.observation!.display, key: "primary" },
      },
    };
    const result = verifyIosRotation(onOtherDisplay, "landscape", duoPrevious());
    expect(result.success).toBe(true);
    expect(result.rotationPerformed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.message).toBe("Successfully rotated from portrait to landscape");
  });

  test("accepts a same-axis portrait repair whose size is legitimately unchanged", () => {
    const result = verifyIosRotation(
      {
        success: true,
        orientation: "portrait",
        value: 0,
        previousOrientation: "landscape",
        currentOrientation: "portrait",
        rotationPerformed: true,
        observation: observation(0, 402, 874),
      },
      "portrait",
      observation(0, 402, 874),
    );
    expect(result.success).toBe(true);
    expect(result.rotationPerformed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.previousOrientation).toBe("portrait");
    expect(result.currentOrientation).toBe("portrait");
  });

  test("accepts a same-axis landscape repair on the Duo inner panel", () => {
    const result = verifyIosRotation(duoRotation(), "landscape", observation(1, 951, 669));
    expect(result.success).toBe(true);
    expect(result.rotationPerformed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("accepts an iPhone rotation when its dimensions change", () => {
    const result = verifyIosRotation(
      {
        success: true,
        orientation: "landscape",
        value: 1,
        previousOrientation: "portrait",
        currentOrientation: "landscape",
        rotationPerformed: true,
        observation: observation(1, 874, 402),
      },
      "landscape",
      observation(0, 402, 874),
    );
    expect(result.success).toBe(true);
    expect(result.message).toBe("Successfully rotated from portrait to landscape");
  });

  test("names the inner panel in the mismatch message (#17385)", () => {
    const result = verifyIosRotation(
      {
        ...duoRotation(),
        observation: observation(0, 951, 669),
        previousOrientation: "unknown",
      },
      "landscape",
      { ...duoPrevious(), display: { ...duoPrevious().display, role: "inner" as const } },
    );
    expect(result.error).toContain(
      "Rotation is not supported on the inner panel (the screen size did not change). The display is still portrait",
    );
  });

  test("preserves the cover-panel refusal mismatch message", () => {
    const result = verifyIosRotation(
      {
        ...duoRotation(),
        observation: observation(0, 951, 669),
        previousOrientation: "unknown",
      },
      "landscape",
      duoPrevious(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "Rotation is not supported on this display (the screen size did not change). The display is still portrait",
    );
  });
});

describe("iOS restore prior from drawn size (#17101)", () => {
  test("uses non-square drawn size over a stale rotation field", () => {
    expect(restoreTargetIosOrientation(observation(0, 951, 669))).toBe("landscape");
    expect(restoreTargetIosOrientation(observation(1, 874, 402))).toBe("landscape");
    expect(restoreTargetIosOrientation(observation(0, 402, 874))).toBe("portrait");
  });

  test("falls back to observed rotation for unknown or square drawn size", () => {
    expect(restoreTargetIosOrientation(observation(undefined, 402, 874))).toBe("portrait");
    expect(restoreTargetIosOrientation(observation(1, 0, 0))).toBe("landscape");
    expect(restoreTargetIosOrientation(observation(1, 500, 500))).toBe("landscape");
  });
});

describe("independent iOS rotate confirmation", () => {
  const before = {
    ...observation(1, 951, 669),
    display: {
      key: "primary-1",
      role: "inner" as const,
      posture: "unknown" as const,
      generation: 0,
    },
  };
  const claimed: RotateResult = {
    success: true,
    orientation: "portrait",
    value: 0,
    rotationPerformed: true,
    observation: { ...observation(0, 669, 951), display: before.display },
  };
  test("a timeout cannot be promoted by flipped observation points", () => {
    const result = verifyIosRotation(
      { ...claimed, success: false, error: "Rotate timed out after 5000ms" },
      "portrait",
      before,
      true,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Rotate timed out after 5000ms");
    expect(result.error).toContain("could not be confirmed");
    expect(result.warning).toBeUndefined();
  });
  test("pixel landscape overrides a claimed inner-panel rotation", () => {
    expect(
      reconcileIosRotationWithDisplayRead(claimed, "portrait", before, {
        width: 2853,
        height: 2007,
      }),
    ).toMatchObject({ success: false, rotationPerformed: false, currentOrientation: "landscape" });
    expect(
      reconcileIosRotationWithDisplayRead(claimed, "portrait", before, {
        width: 2853,
        height: 2007,
      }).error,
    ).toContain("inner panel");
  });
  test.each([{ width: 2007, height: 2853 }, undefined, { width: 10, height: 10 }])(
    "noncontradictory pixels preserve result %p",
    (size) => {
      expect(reconcileIosRotationWithDisplayRead(claimed, "portrait", before, size)).toBe(claimed);
    },
  );
});

describe("simulator display probe", () => {
  const simulator = {
    deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    name: "Duo",
    platform: "ios" as const,
  };
  test("reads a captured screenshot header and forwards the selected display and signal", async () => {
    const pixels = readFileSync("test/fixtures/screenshots/small-element.png");
    const calls: unknown[] = [];
    const probe = new SimulatorIosDisplayPixelProbe(simulator, {
      async screenshot(...args) {
        calls.push(args);
        return pixels;
      },
    });
    const signal = new AbortController().signal;
    const size = await probe.readPixelSize(simulator.deviceId, "primary-1", signal);
    expect(size?.width).toBeGreaterThan(0);
    expect(size?.height).toBeGreaterThan(0);
    expect(calls).toEqual([[simulator.deviceId, "primary-1", signal]]);
  });
  test("never screenshots physical devices", async () => {
    let calls = 0;
    const device = { ...simulator, deviceId: "physical-iphone" };
    const probe = new SimulatorIosDisplayPixelProbe(device, {
      async screenshot() {
        calls++;
        throw new Error("unreachable");
      },
    });
    expect(await probe.readPixelSize(device.deviceId, "default")).toBeUndefined();
    expect(calls).toBe(0);
  });
  test("read failures are best effort", async () => {
    const probe = new SimulatorIosDisplayPixelProbe(simulator, {
      async screenshot() {
        throw new Error("capture unavailable");
      },
    });
    expect(await probe.readPixelSize(simulator.deviceId, "primary-1")).toBeUndefined();
  });
  test("a read failure after cancellation throws instead of reading as indeterminate", async () => {
    const controller = new AbortController();
    const probe = new SimulatorIosDisplayPixelProbe(simulator, {
      async screenshot() {
        controller.abort();
        throw new Error("screenshot aborted");
      },
    });
    await expect(
      probe.readPixelSize(simulator.deviceId, "primary-1", controller.signal),
    ).rejects.toThrow();
  });
});
