import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { strictObjectUnion } from "../../src/models/strictUnion";

describe("strictObjectUnion", () => {
  const arms = [
    z.object({ elementId: z.string() }).strict(),
    z.object({ text: z.string() }).strict(),
  ] as const;

  test("plain z.union collapses to the arm that only failed on an unknown key", () => {
    const result = z.union(arms).safeParse({ elementId: "id", text: 1 });
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(["unrecognized_keys"]);
  });

  test("keeps every arm's issues in an invalid_union", () => {
    const result = strictObjectUnion(arms).safeParse({ elementId: "id", text: 1 });
    const issue = result.error?.issues[0];
    expect(issue?.code).toBe("invalid_union");
    if (issue?.code !== "invalid_union") {
      throw new Error("expected invalid_union");
    }
    expect(issue.errors.map((arm) => arm.map((armIssue) => armIssue.code))).toEqual([
      ["unrecognized_keys"],
      ["invalid_type", "unrecognized_keys"],
    ]);
  });

  test("still accepts a valid arm", () => {
    expect(strictObjectUnion(arms).parse({ text: "ok" })).toEqual({ text: "ok" });
  });
});
