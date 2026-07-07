import { describe, expect, test } from "bun:test";
import { observeSchema } from "../../src/server/observeTools";

describe("observeSchema waitFor.container", () => {
  test("accepts elementId waitFor with container elementId", () => {
    const parsed = observeSchema.parse({
      platform: "android",
      waitFor: {
        elementId: "com.app:id/name",
        timeout: 8000,
        container: { elementId: "com.app:id/list" },
      },
    });
    expect(parsed.waitFor).toMatchObject({
      elementId: "com.app:id/name",
      container: { elementId: "com.app:id/list" },
    });
  });

  test("accepts text waitFor with container text", () => {
    const parsed = observeSchema.parse({
      platform: "android",
      waitFor: {
        text: "Dan Corkill",
        container: { text: "PEOPLE" },
      },
    });
    expect(parsed.waitFor).toMatchObject({
      text: "Dan Corkill",
      container: { text: "PEOPLE" },
    });
  });

  test("accepts textAny waitFor with ordered variants", () => {
    const parsed = observeSchema.parse({
      platform: "ios",
      waitFor: {
        textAny: ["Done", "Add"],
        timeout: 8000,
      },
    });
    expect(parsed.waitFor).toMatchObject({
      textAny: ["Done", "Add"],
      timeout: 8000,
    });
  });

  test("rejects empty textAny waitFor", () => {
    expect(() =>
      observeSchema.parse({
        platform: "ios",
        waitFor: {
          textAny: [],
        },
      })
    ).toThrow();
  });

  test("rejects container object that includes both elementId and text", () => {
    expect(() =>
      observeSchema.parse({
        platform: "android",
        waitFor: {
          elementId: "com.app:id/name",
          container: { elementId: "com.app:id/list", text: "extra" },
        },
      })
    ).toThrow();
  });
});
