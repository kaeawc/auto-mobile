import { describe, expect, test } from "bun:test";
import { FocusVerifier } from "../../../src/features/action/tapFocusVerifier";
import type { BootedDevice } from "../../../src/models";
import type { ObserveResult } from "../../../src/models";

const device = { platform: "android", deviceId: "emu", name: "emu" } as BootedDevice;

function verifier(onFind: () => void = () => {}) {
  return new FocusVerifier({
    device,
    findElementInHierarchy: () => {
      onFind();
      throw new Error("scope unresolved");
    },
    withObservationScreenSize: (options) => options,
  });
}

describe("FocusVerifier", () => {
  const target = { text: "Search", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
  const options = { text: "Search", action: "focus" } as const;

  test("an observation without a hierarchy is unconfirmed", () => {
    expect(verifier().verify(options, target, undefined)).toBe(false);
    expect(verifier().verify(options, target, {} as ObserveResult)).toBe(false);
  });

  test("an unresolvable selector scope means not confirmed rather than an error", () => {
    let finds = 0;
    const observation: Partial<ObserveResult> = { viewHierarchy: { hierarchy: { node: [] } } };
    expect(
      verifier(() => (finds += 1)).verify(
        options,
        target,
        observation as ObserveResult,
        "Search",
        0,
      ),
    ).toBe(false);
  });
});
