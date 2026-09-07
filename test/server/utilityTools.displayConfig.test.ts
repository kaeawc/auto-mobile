import { describe, expect, test } from "bun:test";
import { displayConfigSchema } from "../../src/server/utilityTools";

describe("displayConfigSchema", () => {
  test("rejects reset combined with an explicit field before the handler runs", () => {
    const parsed = displayConfigSchema.safeParse({ reset: true, theme: "dark" });

    expect(parsed.success).toBe(false);
  });

  test("allows reset:false with an explicit field", () => {
    const parsed = displayConfigSchema.safeParse({ reset: false, fontScale: 1.2 });

    expect(parsed.success).toBe(true);
  });

  test("accepts the restorable default font-scale token", () => {
    const parsed = displayConfigSchema.safeParse({ fontScale: "default" });

    expect(parsed.success).toBe(true);
  });

  test("rejects densities below Android's wm density minimum", () => {
    expect(displayConfigSchema.safeParse({ density: 71 }).success).toBe(false);
    expect(displayConfigSchema.safeParse({ density: 72 }).success).toBe(true);
  });
});
