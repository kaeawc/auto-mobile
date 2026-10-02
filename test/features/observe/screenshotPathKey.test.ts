import { expect, test } from "bun:test";
import path from "node:path";
import { screenshotPathKey } from "../../../src/features/observe/screenshotCacheEviction";

test("win32 keys normalize separators, segments and case independently of host cwd", () => {
  const expected = "c:\\users\\dev\\screenshots\\shot.png";
  for (const spelling of [
    "C:/Users/dev/screenshots/shot.png",
    "c:\\users\\DEV\\screenshots\\SHOT.png",
    "C:\\Users/dev\\screenshots/./shot.png",
  ]) {
    const key = screenshotPathKey(spelling, path.win32);
    expect(key).toBe(expected);
    expect(screenshotPathKey(key, path.win32)).toBe(key);
  }
  expect(screenshotPathKey("Screenshots/./SHOT.png", path.win32)).toBe("screenshots\\shot.png");
  expect(screenshotPathKey("C:/Users/dev/screenshots/other.png", path.win32)).not.toBe(expected);
});

test("posix keys normalize segments while preserving case and literal backslashes", () => {
  for (const spelling of ["/tmp/a/shot.png", "/tmp/a/./shot.png", "/tmp//a/shot.png"]) {
    const key = screenshotPathKey(spelling, path.posix);
    expect(key).toBe("/tmp/a/shot.png");
    expect(screenshotPathKey(key, path.posix)).toBe(key);
  }
  expect(screenshotPathKey("/tmp/a/Shot.png", path.posix)).toBe("/tmp/a/Shot.png");
  expect(screenshotPathKey("/tmp/a\\shot.png", path.posix)).toBe("/tmp/a\\shot.png");
  expect(screenshotPathKey("a/./Shot.png", path.posix)).toBe("a/Shot.png");
});
