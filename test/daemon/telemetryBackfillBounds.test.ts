import { describe, expect, test } from "bun:test";
import { boundBackfillEventText } from "../../src/daemon/telemetryPushSocketServer";
import type { TelemetryEvent } from "../../src/features/telemetry/TelemetryRecorder";
import { BODY_TRUNCATION_LIMIT } from "../../src/utils/truncateBodyText";

function event(category: TelemetryEvent["category"], data: unknown): TelemetryEvent {
  return { category, data, timestamp: 1, deviceId: null, sessionId: null };
}

describe("telemetry backfill field bounds", () => {
  test.each([null, undefined, "text", 42])("retains non-object data %p", (data) => {
    const source = event("log", data);
    expect(boundBackfillEventText(source)).toBe(source);
  });

  test("retains unrelated categories and unchanged text fields by identity", () => {
    for (const source of [
      event("network", { message: "x".repeat(20_000) }),
      event("log", { message: "short" }),
      event("storage", { value: null, previousValue: 42 }),
    ]) {
      expect(boundBackfillEventText(source)).toBe(source);
    }
  });

  test("bounds both storage fields in a single copy without mutating the source", () => {
    const data = { value: "v".repeat(20_000), previousValue: "p".repeat(20_000), key: "key" };
    const source = event("storage", data);
    const bounded = boundBackfillEventText(source);
    expect(bounded).not.toBe(source);
    expect(bounded.data).toEqual({
      value: "v".repeat(BODY_TRUNCATION_LIMIT),
      previousValue: "p".repeat(BODY_TRUNCATION_LIMIT),
      key: "key",
    });
    expect(data.value.length).toBe(20_000);
    expect(data.previousValue.length).toBe(20_000);
  });

  test("preserves a short first field when only the second storage field changes", () => {
    const source = event("storage", { value: "short", previousValue: "p".repeat(20_000) });
    expect(boundBackfillEventText(source).data).toEqual({
      value: "short",
      previousValue: "p".repeat(BODY_TRUNCATION_LIMIT),
    });
  });

  test("bounds log text without splitting a surrogate pair", () => {
    const message = "x".repeat(BODY_TRUNCATION_LIMIT - 1) + "😀suffix";
    const source = event("log", { message, tag: "tag" });
    expect(boundBackfillEventText(source).data).toEqual({
      message: "x".repeat(BODY_TRUNCATION_LIMIT - 1),
      tag: "tag",
    });
    expect(source.data).toEqual({ message, tag: "tag" });
  });

  test.each([
    { category: "os" as const, field: "details", value: { blob: "x".repeat(20_000) } },
    {
      category: "layout" as const,
      field: "detailsJson",
      value: JSON.stringify({ blob: "x".repeat(20_000) }),
    },
  ])("bounds $category structured fields without mutating source", ({ category, field, value }) => {
    const data = { [field]: value, extra: "retained" };
    const source = event(category, data);
    expect(boundBackfillEventText(source).data).toEqual({
      [field]: {
        _truncated: true,
        bytes: typeof value === "string" ? value.length : JSON.stringify(value).length,
      },
      extra: "retained",
    });
    expect(data[field]).toBe(value);
  });

  test.each([
    event("os", { details: { screen: "Home" } }),
    event("os", { details: null }),
    event("layout", { detailsJson: "{}" }),
    event("layout", { detailsJson: {} }),
    event("layout", {}),
  ])("retains unchanged structured fields by identity %p", (source) => {
    expect(boundBackfillEventText(source)).toBe(source);
  });
});
