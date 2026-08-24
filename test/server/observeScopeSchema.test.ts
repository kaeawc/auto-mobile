import { describe, expect, test } from "bun:test";
import { observeSchema } from "../../src/server/observeTools";

/**
 * The `observe` tool's `scope` input (issue #4344). The agent picks where to zoom
 * per screen, so region/anchor are per-call inputs — this pins the schema contract
 * a client relies on: booleans, anchor objects, and normalized region validation.
 */
const BASE = { platform: "android" as const };

function parse(scope: unknown): { success: boolean } {
  return observeSchema.safeParse({ ...BASE, scope });
}

describe("observe scope input schema", () => {
  test("scope is optional (backward compatible)", () => {
    expect(observeSchema.safeParse(BASE).success).toBe(true);
  });

  test("accepts focus:true and an anchor object", () => {
    expect(parse({ focus: true }).success).toBe(true);
    expect(parse({ focus: { resourceId: "com.app:id/list" } }).success).toBe(true);
    expect(parse({ focus: { text: "Inbox" } }).success).toBe(true);
  });

  test("accepts region:true and a normalized box", () => {
    expect(parse({ region: true }).success).toBe(true);
    expect(parse({ region: { x1: 0, y1: 0, x2: 1, y2: 0.5 } }).success).toBe(true);
  });

  test("accepts overview and a combined scope", () => {
    expect(parse({ overview: true }).success).toBe(true);
    expect(
      parse({ focus: true, region: { x1: 0, y1: 0.25, x2: 1, y2: 0.75 }, overview: true }).success,
    ).toBe(true);
  });

  test("rejects a region box outside [0,1]", () => {
    expect(parse({ region: { x1: 0, y1: 0, x2: 1, y2: 2 } }).success).toBe(false);
    expect(parse({ region: { x1: -0.1, y1: 0, x2: 1, y2: 1 } }).success).toBe(false);
  });

  test("rejects a misordered region box (x1 >= x2 or y1 >= y2)", () => {
    expect(parse({ region: { x1: 0.5, y1: 0, x2: 0.5, y2: 1 } }).success).toBe(false);
    expect(parse({ region: { x1: 1, y1: 0, x2: 0, y2: 1 } }).success).toBe(false);
    expect(parse({ region: { x1: 0, y1: 0.8, x2: 1, y2: 0.2 } }).success).toBe(false);
  });
});
