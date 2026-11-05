import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  normalizeIosOrientation,
  observedIosOrientation,
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

describe("iOS rotation verification screen-size checks (#17047)", () => {
  test("rejects a Duo landscape rotation when the panel size is unchanged", () => {
    const result = verifyIosRotation(duoRotation(), "landscape", duoPrevious());
    expect(result.success).toBe(false);
    expect(result.rotationPerformed).toBe(false);
    expect(result.error).toBe(
      "Rotation is not supported on this display (the screen size did not change). The runner reported a rotation but the screen size is unchanged.",
    );
    expect(result.message).toBe("Failed to rotate to landscape; the screen size did not change.");
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
