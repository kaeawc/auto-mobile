import { expect, spyOn, test } from "bun:test";
import path from "node:path";
import {
  BoundedScreenshotPathProtection,
  MAX_SCREENSHOT_PATH_PROTECTIONS,
} from "../../../src/features/observe/ScreenshotPathProtection";
import { SCREENSHOT_MIN_LIFETIME_MS } from "../../../src/features/observe/screenshotCacheEviction";
import { FakeTimer } from "../../fakes/FakeTimer";
import { logger } from "../../../src/utils/logger";

test("win32 protection shares separator and case variants without covering other files", async () => {
  const registry = new BoundedScreenshotPathProtection(new FakeTimer(), path.win32);
  await registry.protect("C:/Users/dev/screenshots/shot.png");
  for (const spelling of [
    "C:\\Users\\dev\\screenshots\\shot.png",
    "c:\\users\\dev\\screenshots\\SHOT.png",
    "C:\\Users/dev\\screenshots/shot.png",
  ]) {
    expect(registry.isProtected(spelling)).toBe(true);
  }
  expect(registry.isProtected("C:/Users/dev/screenshots/other.png")).toBe(false);
  let removed = false;
  expect(
    await registry.removeIfUnprotected("C:\\Users\\dev\\screenshots\\shot.png", async () => {
      removed = true;
      return true;
    }),
  ).toBe(false);
  expect(removed).toBe(false);
});

test("posix protection normalizes segments while preserving case and literal backslashes", async () => {
  const registry = new BoundedScreenshotPathProtection(new FakeTimer(), path.posix);
  await registry.protect("/tmp/a/shot.png");
  expect(registry.isProtected("/tmp/a/./shot.png")).toBe(true);
  expect(registry.isProtected("/tmp//a/shot.png")).toBe(true);
  expect(registry.isProtected("/tmp/a/Shot.png")).toBe(false);
  expect(registry.isProtected("/tmp/a\\shot.png")).toBe(false);
});

for (const [flavour, pathModule, original, alternate] of [
  ["win32", path.win32, "C:/Users/dev/shot.png", "c:\\users\\DEV\\shot.png"],
  ["posix", path.posix, "/tmp/a/shot.png", "/tmp//a/./shot.png"],
] as const) {
  test(`${flavour} publication waits for removal under an equivalent spelling`, async () => {
    const registry = new BoundedScreenshotPathProtection(new FakeTimer(), pathModule);
    let finish!: (removed: boolean) => void;
    const removal = registry.removeIfUnprotected(
      original,
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    let returned = false;
    const publication = registry.protect(alternate).then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);
    let duplicateRemoved = false;
    expect(
      await registry.removeIfUnprotected(alternate, async () => {
        duplicateRemoved = true;
        return true;
      }),
    ).toBe(false);
    expect(duplicateRemoved).toBe(false);
    finish(true);
    await removal;
    await publication;
    expect(registry.isProtected(original)).toBe(true);
  });
}

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
