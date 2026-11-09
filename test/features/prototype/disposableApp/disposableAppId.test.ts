import { describe, expect, test } from "bun:test";
import {
  assertDisposableAppId,
  DISPOSABLE_APP_ID_PREFIX,
  disposableAppId,
  isDisposableAppId,
} from "../../../../src/features/prototype/disposableApp/disposableAppId";

describe("disposableAppId", () => {
  test("derives the reserved prefix, slug and an 8-hex sha256 digest", () => {
    const android = disposableAppId("android", "news-reader");
    const ios = disposableAppId("ios", "news-reader");
    expect(android).toMatch(/^dev\.jasonpearson\.automobile\.app\.news_reader_[0-9a-f]{8}$/);
    expect(ios).toMatch(/^dev\.jasonpearson\.automobile\.app\.news-reader-[0-9a-f]{8}$/);
    expect(android.slice(-8)).toBe(ios.slice(-8));
    expect(disposableAppId("android", "news-reader")).toBe(android);
    expect(disposableAppId("android", "feedly")).not.toBe(android);
  });

  test("Android ids are valid package names", () => {
    const id = disposableAppId("android", "a1-b2-c3");
    expect(id.split(".").every((segment) => /^[A-Za-z][A-Za-z0-9_]*$/.test(segment))).toBe(true);
  });

  test.each([
    "",
    "Feedly",
    "1app",
    "news--reader",
    "news-",
    "-news",
    "news.reader",
    "a".repeat(49),
  ])("refuses slug %p", (slug) => {
    expect(() => disposableAppId("android", slug)).toThrow(/app\.slug/);
  });

  test("prefix enforcement refuses ids outside the reserved prefix", () => {
    expect(isDisposableAppId(disposableAppId("ios", "feedly"))).toBe(true);
    expect(isDisposableAppId(DISPOSABLE_APP_ID_PREFIX)).toBe(false);
    expect(isDisposableAppId("com.feedly.android")).toBe(false);
    expect(isDisposableAppId("dev.jasonpearson.automobile.proto.x-12345678")).toBe(false);
    expect(() => assertDisposableAppId("com.feedly.android")).toThrow(/not a disposable/);
    expect(() => assertDisposableAppId(disposableAppId("android", "feedly"))).not.toThrow();
  });
});
