import { describe, expect, test } from "bun:test";
import {
  normalizeIosOrientation,
  observedIosOrientation,
} from "../../../src/features/action/iosRotateVerification";
import type { ObserveResult } from "../../../src/models";

const observation = (rotation?: number, width = 402, height = 874): ObserveResult => ({
  timestamp: 1000,
  rotation,
  screenSize: { width, height },
  systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
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
      expect(normalizeIosOrientation(raw)).toBe(expected);
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
