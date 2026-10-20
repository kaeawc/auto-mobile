import { describe, expect, test } from "bun:test";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  TapEnsureCheckedPhase,
  ENSURE_CHECKED_POLL_TIMEOUT_MS,
  type EnsureCheckedHost,
} from "../../../src/features/action/tapEnsureCheckedPhase";
import type { Element, ObserveResult, TapOnElementResult } from "../../../src/models";

function phase(overrides: Partial<EnsureCheckedHost> = {}) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const host: EnsureCheckedHost = {
    timer,
    tapVerificationRefresh: () => async () => null,
    findElementInHierarchy: () => ({ selection: { element: undefined } }) as never,
    withObservationScreenSize: (options) => options,
    replaceObservationHierarchy: () => {},
    elementAffordances: () => [],
    elementIdentity: (element) => element.text ?? "unidentified element",
    ...overrides,
  };
  return new TapEnsureCheckedPhase(host);
}

const options = (ensureChecked?: boolean) => ({ action: "tap", ensureChecked }) as never;
const searchUntil = {} as NonNullable<TapOnElementResult["searchUntil"]>;

describe("TapEnsureCheckedPhase.beforeTap", () => {
  test("is a no-op without ensureChecked", () => {
    expect(
      phase().beforeTap(options(), { text: "a" } as Element, undefined, searchUntil),
    ).toBeUndefined();
  });

  test("rejects non-toggle elements naming the identity and affordances", () => {
    const p = phase({ elementAffordances: () => ["tap"] });
    expect(() =>
      p.beforeTap(options(true), { text: "Save" } as Element, undefined, searchUntil),
    ).toThrow("Save has affordances: tap");
  });

  test("skips the tap when already in the requested state", () => {
    const element = { text: "t", checkable: true, checked: true } as Element;
    const result = phase().beforeTap(options(true), element, undefined, searchUntil);
    expect(result?.skipped).toBe("already-checked");
    expect(phase().beforeTap(options(false), element, undefined, searchUntil)).toBeUndefined();
  });
});

describe("TapEnsureCheckedPhase.applyResult", () => {
  test("fails the result when the toggle never reaches the expected state", async () => {
    const observation = { viewHierarchy: { hierarchy: {} } } as ObserveResult;
    const result = { success: true, observation } as TapOnElementResult;
    await phase({
      findElementInHierarchy: () => ({ selection: { element: { checked: false } } }) as never,
    }).applyResult(result, options(true) as never);
    expect(result.success).toBe(false);
    expect(result.error).toContain("checked is now false (expected true)");
    expect(ENSURE_CHECKED_POLL_TIMEOUT_MS).toBe(750);
  });

  test("leaves a satisfied result untouched", async () => {
    const observation = { viewHierarchy: { hierarchy: {} } } as ObserveResult;
    const result = { success: true, observation } as TapOnElementResult;
    await phase({
      findElementInHierarchy: () => ({ selection: { element: { checked: true } } }) as never,
    }).applyResult(result, options(true) as never);
    expect(result.success).toBe(true);
  });
});
