import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { assertPathInside, isPathInside } from "../../../src/utils/filesystem/pathContainment";

const posix = { paths: path.posix };
const win = { paths: path.win32 };

describe("isPathInside", () => {
  const cases: Array<[string, string, string, boolean, object]> = [
    ["child", "/a/b", "c/d.txt", true, posix],
    ["absolute child", "/a/b", "/a/b/c", true, posix],
    ["root itself", "/a/b", "/a/b", true, posix],
    ["dot", "/a/b", ".", true, posix],
    ["trailing slash root", "/a/b/", "c", true, posix],
    ["parent", "/a/b", "..", false, posix],
    ["dotdot traversal", "/a/b", "../c", false, posix],
    ["nested traversal back out", "/a/b", "c/../../x", false, posix],
    ["traversal that stays inside", "/a/b", "c/../d", true, posix],
    ["absolute outside", "/a/b", "/etc/passwd", false, posix],
    ["name-prefix sibling", "/a/b", "/a/b-evil/x", false, posix],
    ["dotdot-prefixed name inside", "/a/b", "..hidden/x", true, posix],
    ["posix is case-sensitive", "/a/B", "/a/b/c", false, posix],
    ["symlink-looking path is lexical", "/a/b", "link/../link2", true, posix],
    ["win child with backslashes", "C:\\a\\b", "c\\d", true, win],
    ["win child with forward slashes", "C:\\a\\b", "c/d", true, win],
    ["win traversal", "C:\\a\\b", "..\\c", false, win],
    ["win case-insensitive", "C:\\A\\B", "c:\\a\\b\\c", true, win],
    ["win other drive", "C:\\a\\b", "D:\\a\\b\\c", false, win],
    ["win drive-relative escape", "C:\\a\\b", "D:evil", false, win],
    ["win prefix sibling", "C:\\a\\b", "C:\\a\\b-evil", false, win],
    ["win UNC outside", "C:\\a\\b", "\\\\host\\share\\x", false, win],
  ];
  for (const [name, root, target, expected, opts] of cases) {
    test(name, () => {
      expect(isPathInside(root, target, opts)).toBe(expected);
    });
  }

  test("a relative root and relative target resolve against the cwd", () => {
    expect(isPathInside("rel/root", "child")).toBe(true);
    expect(isPathInside("rel/root", "../sibling")).toBe(false);
    expect(isPathInside("rel/root", path.resolve("rel/root/deep"))).toBe(true);
  });

  test("posix flavour stays posix for iOS fixture paths even on a win32 host", () => {
    const opts = { paths: path.posix, allowEqual: false };
    expect(isPathInside("/Users/x/Library/ns", "/Users/x/Library/ns", opts)).toBe(false);
    expect(isPathInside("/Users/x/Library/ns", "/Users/x/Library/ns/a/b.txt", opts)).toBe(true);
    expect(isPathInside("/Users/x/Library/ns", "/Users/x/Library/ns/../other", opts)).toBe(false);
  });

  test("allowEqual false rejects the root itself only", () => {
    expect(isPathInside("/a/b", "/a/b", { ...posix, allowEqual: false })).toBe(false);
    expect(isPathInside("/a/b", "c", { ...posix, allowEqual: false })).toBe(true);
    expect(isPathInside("C:\\a", "c:\\A", { ...win, allowEqual: false })).toBe(false);
  });
});

describe("assertPathInside", () => {
  test("returns the resolved path", () => {
    expect(assertPathInside("/a/b", "c/../d", () => new Error("x"), posix)).toBe("/a/b/d");
  });

  test("throws the caller's error on escape", () => {
    expect(() => assertPathInside("/a/b", "../x", () => new RangeError("nope"), posix)).toThrow(
      RangeError,
    );
  });
});
