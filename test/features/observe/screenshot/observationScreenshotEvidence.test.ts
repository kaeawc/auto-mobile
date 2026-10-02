import { expect, test } from "bun:test";
import { observationScreenshotEvidence } from "../../../../src/features/observe/screenshot/observationScreenshotEvidence";
import { BoundedScreenshotPathProtection } from "../../../../src/features/observe/ScreenshotPathProtection";
import { SCREENSHOT_PATH_MIN_LIFETIME_MS } from "../../../../src/features/observe/ScreenshotRetention";
import { FakeTimer } from "../../../fakes/FakeTimer";

test("arms before stat and rearms at return after a slow stat", async () => {
  const timer = new FakeTimer();
  const protection = new BoundedScreenshotPathProtection(timer);
  const evidence = await observationScreenshotEvidence("/cached.png", "cached", undefined, {
    files: {
      stat: async (path) => {
        expect(protection.isProtected(path)).toBe(true);
        timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS + 1);
        return { size: 1, mtimeMs: 0, isFile: () => true };
      },
    },
    timer,
    protection,
  });
  expect(evidence.screenshotSource).toBe("cached");
  expect(evidence).toHaveProperty("screenshotExpiresAt", timer.now() + 600_000);
  timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS - 1);
  expect(protection.isProtected(evidence.screenshotPath)).toBe(true);
  timer.advanceTime(1);
  expect(protection.isProtected(evidence.screenshotPath)).toBe(false);
});

test("an unlink already in flight finishes before stat and the gone file is never advertised", async () => {
  const timer = new FakeTimer();
  const protection = new BoundedScreenshotPathProtection(timer);
  let finish!: (removed: boolean) => void;
  let exists = true;
  const removal = protection.removeIfUnprotected(
    "/cached.png",
    () =>
      new Promise<boolean>((resolve) => {
        finish = (removed) => {
          exists = false;
          resolve(removed);
        };
      }),
  );
  await Promise.resolve();
  const evidence = observationScreenshotEvidence("/cached.png", "cached", undefined, {
    files: {
      stat: async () => {
        if (!exists) {
          throw new Error("ENOENT");
        }
        return { size: 1, mtimeMs: 0, isFile: () => true };
      },
    },
    timer,
    protection,
  });
  finish(true);
  await removal;
  await expect(evidence).rejects.toThrow("ENOENT");
});
