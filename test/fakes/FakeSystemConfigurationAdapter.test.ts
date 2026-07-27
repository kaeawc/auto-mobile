import { describe, it, expect, beforeEach } from "bun:test";
import { FakeSystemConfigurationAdapter } from "./FakeSystemConfigurationAdapter";

/**
 * Self-tests for the FakeSystemConfigurationAdapter test double. These exercise
 * only the fake (its recording/stubbing behavior), never production code, so they
 * live beside the fake under test/fakes/ per the repo convention
 * (FakeAdbClientFactory.test.ts, FakeFailureRecorder.test.ts). Moved out of
 * test/features/utility/SystemConfigurationAdapter.test.ts, which should test the
 * real adapters, not the fake.
 */
describe("FakeSystemConfigurationAdapter", () => {
  let fake: FakeSystemConfigurationAdapter;

  beforeEach(() => {
    fake = new FakeSystemConfigurationAdapter();
  });

  it("records each method invocation", async () => {
    await fake.setLocale("ja-JP", { broadcast: true });
    await fake.setTimeZone("Asia/Tokyo");
    await fake.setTextDirection(true, {});
    await fake.set24HourFormat(true);
    await fake.setCalendarSystem("japanese");
    await fake.getCalendarSystem();
    await fake.getLocalizationSettings();
    await fake.broadcastLocaleChange();

    expect(fake.wasMethodCalled("setLocale")).toBe(true);
    expect(fake.wasMethodCalled("setTimeZone")).toBe(true);
    expect(fake.wasMethodCalled("setTextDirection")).toBe(true);
    expect(fake.wasMethodCalled("set24HourFormat")).toBe(true);
    expect(fake.wasMethodCalled("setCalendarSystem")).toBe(true);
    expect(fake.wasMethodCalled("getCalendarSystem")).toBe(true);
    expect(fake.wasMethodCalled("getLocalizationSettings")).toBe(true);
    expect(fake.wasMethodCalled("broadcastLocaleChange")).toBe(true);
  });

  it("captures call arguments in the recorded operation string", async () => {
    await fake.setLocale("fr-CA", { broadcast: false });
    await fake.setTimeZone("Europe/Paris");

    const ops = fake.getExecutedOperations();
    expect(ops).toContain("setLocale:fr-CA:false");
    expect(ops).toContain("setTimeZone:Europe/Paris");
  });

  it("clears recorded history on demand", async () => {
    await fake.broadcastLocaleChange();
    fake.clearHistory();
    expect(fake.getExecutedOperations()).toEqual([]);
  });

  it("returns the configured stub results", async () => {
    fake.setLocaleResult = { success: false, languageTag: "x-y", error: "stubbed" };
    const result = await fake.setLocale("x-y", {});
    expect(result.success).toBe(false);
    expect(result.error).toBe("stubbed");
  });

  it("counts each invocation independently", async () => {
    await fake.broadcastLocaleChange();
    await fake.broadcastLocaleChange();
    await fake.broadcastLocaleChange();
    expect(fake.getCallCount("broadcastLocaleChange")).toBe(3);
  });
});
