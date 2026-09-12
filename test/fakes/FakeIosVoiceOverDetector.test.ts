import { describe, expect, test } from "bun:test";
import { FakeIOSCtrlProxy } from "./FakeIOSCtrlProxy";
import { FakeIosVoiceOverDetector } from "./FakeIosVoiceOverDetector";

describe("FakeIosVoiceOverDetector", () => {
  test("preserves queued null probes before legacy boolean results and the configured fallback", async () => {
    const detector = new FakeIosVoiceOverDetector();
    const client = new FakeIOSCtrlProxy();
    detector.setVoiceOverEnabled(true);
    detector.enqueueVoiceOverEnabledResults(false);
    detector.enqueueResolvedStateResults(null);

    await expect(detector.resolveState("device", client)).resolves.toBeNull();
    await expect(detector.resolveState("device", client)).resolves.toBe(false);
    await expect(detector.resolveState("device", client)).resolves.toBe(true);
  });

  test("can persist an indeterminate probe and clears it on reset", async () => {
    const detector = new FakeIosVoiceOverDetector();
    const client = new FakeIOSCtrlProxy();
    detector.setPersistentResolvedState(null);

    await expect(detector.resolveState("device", client)).resolves.toBeNull();
    detector.reset();
    await expect(detector.resolveState("device", client)).resolves.toBe(false);
  });
});
