import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as path from "node:path";
import { isPathInside } from "../../../src/utils/filesystem/pathContainment";

const RUN_OPTIONS = { seed: 4_761_011, numRuns: 300 } as const;

const segment = fc.stringMatching(/^[a-zA-Z0-9_-]{1,8}$/);
const segments = fc.array(segment, { maxLength: 5 });
const posixRoot = segments.map((parts) => path.posix.join("/", "root", ...parts));

/**
 * Reference model: resolve the steps against the root's segments with a clamped stack (like
 * `path.resolve` on an absolute path) and check the root's segments are still a prefix.
 * A path that climbs out and re-enters the root (`/root/a` + `../a`) is therefore inside.
 */
function modelInside(root: string, steps: string[]): boolean {
  const rootParts = root.split("/").filter(Boolean);
  const stack = [...rootParts];
  for (const step of steps) {
    if (step === "..") {
      stack.pop();
    } else if (step !== ".") {
      stack.push(step);
    }
  }
  return rootParts.every((part, index) => stack[index] === part);
}

describe("isPathInside properties", () => {
  const stepArb = fc.oneof(segment, fc.constant(".."), fc.constant("."));

  test("climbing out and re-entering the root is inside (lexical, as path.resolve)", () => {
    expect(isPathInside("/root/a", "../a", { paths: path.posix })).toBe(true);
    expect(isPathInside("/root", "../../root", { paths: path.posix })).toBe(true);
  });

  test("agrees with a stack model for any relative `..`/`.`/name sequence (posix)", () => {
    fc.assert(
      fc.property(posixRoot, fc.array(stepArb, { maxLength: 8 }), (root, steps) => {
        const target = steps.join("/") || ".";
        expect(isPathInside(root, target, { paths: path.posix })).toBe(modelInside(root, steps));
      }),
      RUN_OPTIONS,
    );
  });

  test("any path built from the root plus plain segments is inside; the root only if allowed", () => {
    fc.assert(
      fc.property(posixRoot, segments, (root, parts) => {
        const target = path.posix.join(root, ...parts);
        expect(isPathInside(root, target, { paths: path.posix })).toBe(true);
        expect(isPathInside(root, target, { paths: path.posix, allowEqual: false })).toBe(
          parts.length > 0,
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("climbing above the root and entering a differently named directory is always outside", () => {
    fc.assert(
      fc.property(posixRoot, segments, fc.integer({ min: 1, max: 4 }), (root, parts, extra) => {
        const up = Array(parts.length + extra).fill("..");
        const target = path.posix.join(...parts, ...up, "outside-the-root");
        expect(isPathInside(root, target, { paths: path.posix })).toBe(false);
      }),
      RUN_OPTIONS,
    );
  });

  test("a name-prefix sibling of the root is never inside", () => {
    fc.assert(
      fc.property(posixRoot, segment, segments, (root, suffix, parts) => {
        const sibling = path.posix.join(`${root}-${suffix}`, ...parts);
        expect(isPathInside(root, sibling, { paths: path.posix })).toBe(false);
      }),
      RUN_OPTIONS,
    );
  });

  test("win32: separators and letter case do not change the answer", () => {
    fc.assert(
      fc.property(segments, segments, (rootParts, childParts) => {
        const root = path.win32.join("C:\\", "root", ...rootParts);
        const child = path.win32.join(root, ...childParts);
        const variants = [
          child,
          child.replaceAll("\\", "/"),
          child.toUpperCase(),
          child.toLowerCase(),
        ];
        for (const variant of variants) {
          expect(isPathInside(root, variant, { paths: path.win32 })).toBe(true);
        }
        expect(isPathInside(root, child.replace("C:", "D:"), { paths: path.win32 })).toBe(false);
      }),
      RUN_OPTIONS,
    );
  });
});
