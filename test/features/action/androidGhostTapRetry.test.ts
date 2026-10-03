import { describe, expect, spyOn, test } from "bun:test";
import {
  checkAndroidTapHierarchyChange,
  POST_TAP_REFRESH_TIMEOUT_MS,
  POST_TAP_SETTLE_MS,
} from "../../../src/features/action/androidGhostTapRetry";
import type { ViewHierarchyResult } from "../../../src/models";
import { StaleDisplayError } from "../../../src/models/StaleDisplayError";
import { DisplaySelectionError } from "../../../src/features/observe/DisplaySelection";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";

const hierarchy: ViewHierarchyResult = { hierarchy: { node: {} } };

describe("checkAndroidTapHierarchyChange", () => {
  for (const [name, preHash, postHash, refreshed, expected] of [
    ["equal hashes", "before", "before", hierarchy, { status: "unchanged", hierarchy }],
    ["different hashes", "before", "after", hierarchy, { status: "changed" }],
    ["unknown post hash", "before", null, hierarchy, { status: "unavailable" }],
    ["unknown pre hash", null, "after", hierarchy, { status: "unavailable" }],
    ["empty pre hash", "", "after", hierarchy, { status: "unavailable" }],
    ["empty post hash", "before", "", hierarchy, { status: "unavailable" }],
    ["missing refresh", "before", "after", null, { status: "unavailable" }],
  ] as const) {
    test(name, async () => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const timeouts: number[] = [];
      const hashed: ViewHierarchyResult[] = [];
      const result = await checkAndroidTapHierarchyChange(
        timer,
        async (timeoutMs) => {
          expect(timer.getSleepHistory()).toEqual([POST_TAP_SETTLE_MS]);
          timeouts.push(timeoutMs);
          return refreshed;
        },
        (tree) => {
          hashed.push(tree);
          return postHash;
        },
        preHash,
      );
      expect(result).toEqual(expected);
      if (result.status === "unchanged") {
        expect(result.hierarchy).toBe(hierarchy);
      }
      expect(timer.getSleepHistory()).toEqual([POST_TAP_SETTLE_MS]);
      expect(timeouts).toEqual([POST_TAP_REFRESH_TIMEOUT_MS]);
      expect(hashed).toEqual(refreshed && preHash ? [hierarchy] : []);
    });
  }

  test("warns and returns unavailable when refresh fails", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const failure = new Error("hierarchy transport failed");
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(
        await checkAndroidTapHierarchyChange(
          timer,
          async () => {
            throw failure;
          },
          () => "before",
          "before",
        ),
      ).toEqual({ status: "unavailable" });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(failure.message), failure);
    } finally {
      warning.mockRestore();
    }
  });

  for (const failure of [
    new DOMException("cancelled", "AbortError"),
    Object.assign(new Error("cancelled"), { name: "AbortError" }),
    new StaleDisplayError({ observedGeneration: 0, currentGeneration: 1, retry: "observe" }),
    new DisplaySelectionError("selected display unavailable"),
  ]) {
    test(`rethrows ${failure.name}`, async () => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      await expect(
        checkAndroidTapHierarchyChange(
          timer,
          async () => {
            throw failure;
          },
          () => "before",
          "before",
        ),
      ).rejects.toBe(failure);
    });
  }

  for (const ambient of [false, true]) {
    test(`rethrows refresh failure when ${ambient ? "ambient" : "explicit"} signal aborts`, async () => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const controller = new AbortController();
      const failure = new Error("cancelled during refresh");
      await expect(
        runWithAbortSignal(ambient ? controller.signal : undefined, () =>
          checkAndroidTapHierarchyChange(
            timer,
            async () => {
              controller.abort(failure);
              throw failure;
            },
            () => "before",
            "before",
            ambient ? undefined : controller.signal,
          ),
        ),
      ).rejects.toBe(failure);
    });
  }
});
