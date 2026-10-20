import { describe, expect, test } from "bun:test";
import {
  resolveReleaseReplyBudgetMs,
  SESSION_BROKER_RELEASE_REPLY_BUDGET_MS,
} from "../../../src/daemon/sessionBroker/releaseReply";

describe("resolveReleaseReplyBudgetMs", () => {
  test.each([
    { requested: -1, expected: 0 },
    { requested: 0, expected: 0 },
    { requested: 2.5, expected: 2.5 },
    { requested: 30_000, expected: 30_000 },
    { requested: 30_001, expected: 30_000 },
  ])("clamps finite caller budget $requested to $expected", ({ requested, expected }) => {
    expect(resolveReleaseReplyBudgetMs(requested, 20)).toBe(expected);
  });

  test.each([undefined, NaN, Infinity, -Infinity])(
    "uses configured or default budget for caller budget %p",
    (requested) => {
      expect(resolveReleaseReplyBudgetMs(requested, 20)).toBe(20);
      expect(resolveReleaseReplyBudgetMs(requested, 0)).toBe(0);
      expect(resolveReleaseReplyBudgetMs(requested, 30_001)).toBe(30_001);
      expect(resolveReleaseReplyBudgetMs(requested)).toBe(SESSION_BROKER_RELEASE_REPLY_BUDGET_MS);
    },
  );
});
