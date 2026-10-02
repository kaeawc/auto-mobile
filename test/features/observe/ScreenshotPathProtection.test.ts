import { expect, spyOn, test } from "bun:test";
import {
  BoundedScreenshotPathProtection,
  MAX_SCREENSHOT_PATH_PROTECTIONS,
} from "../../../src/features/observe/ScreenshotPathProtection";
import { SCREENSHOT_MIN_LIFETIME_MS } from "../../../src/features/observe/screenshotCacheEviction";
import { FakeTimer } from "../../fakes/FakeTimer";
import { logger } from "../../../src/utils/logger";

test("publication extends a lease and expiry follows FakeTimer exactly", async () => {
  const timer = new FakeTimer();
  const registry = new BoundedScreenshotPathProtection(timer);
  await registry.protect("cached");
  timer.advanceTime(SCREENSHOT_MIN_LIFETIME_MS - 1);
  await registry.protect("cached");
  timer.advanceTime(1);
  expect(registry.isProtected("cached")).toBe(true);
  timer.advanceTime(SCREENSHOT_MIN_LIFETIME_MS - 1);
  expect(registry.isProtected("cached")).toBe(false);
});

test("hard ceiling drops oldest protection with a warning; rearmed entries stay newest", async () => {
  const timer = new FakeTimer();
  const registry = new BoundedScreenshotPathProtection(timer);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    for (let i = 0; i < MAX_SCREENSHOT_PATH_PROTECTIONS; i++) {
      await registry.protect(`path-${i}`);
    }
    await registry.protect("path-0");
    await registry.protect("overflow");
    expect(registry.isProtected("path-0")).toBe(true);
    expect(registry.isProtected("path-1")).toBe(false);
    expect(registry.isProtected("overflow")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("dropped oldest protection");
    timer.advanceTime(SCREENSHOT_MIN_LIFETIME_MS);
    await registry.protect("after-expiry");
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

test("publication waits for an already-started unlink before validating a path", async () => {
  const registry = new BoundedScreenshotPathProtection(new FakeTimer());
  let finish!: (removed: boolean) => void;
  const removal = registry.removeIfUnprotected(
    "path",
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  let returned = false;
  const publication = registry.protect("path").then(() => {
    returned = true;
  });
  await Promise.resolve();
  expect(returned).toBe(false);
  finish(true);
  await removal;
  await publication;
  expect(registry.isProtected("path")).toBe(true);
  expect(await registry.removeIfUnprotected("path", async () => true)).toBe(false);
});
