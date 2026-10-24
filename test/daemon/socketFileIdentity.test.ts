import { describe, expect, test } from "bun:test";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifySocketPath,
  isOwnedSocketFile,
  sameFileIdentity,
  statFileIdentity,
} from "../../src/daemon/socketFileIdentity";
import { useScratchRoot } from "../helpers/scratchRoot";

describe("socket file identity", () => {
  const scratch = useScratchRoot("socket-file-identity-");

  test("ids that round to one number above 2^53 are distinct identities", () => {
    const ino = 12_947_848_930_067_504n;
    expect(Number(ino)).toBe(Number(ino + 1n));
    expect(sameFileIdentity({ dev: 1n, ino }, { dev: 1n, ino })).toBe(true);
    expect(sameFileIdentity({ dev: 1n, ino }, { dev: 1n, ino: ino + 1n })).toBe(false);
    expect(sameFileIdentity({ dev: 1n, ino }, { dev: 2n, ino })).toBe(false);
  });

  test("statFileIdentity reads the exact bigint identity", () => {
    const path = join(scratch.next(), "file");
    writeFileSync(path, "x");
    const { dev, ino } = statSync(path, { bigint: true });
    expect(statFileIdentity(path)).toEqual({ dev, ino });
  });

  test("isOwnedSocketFile matches only the recorded file", () => {
    const dir = scratch.next();
    const path = join(dir, "socket");
    writeFileSync(path, "x");
    const recorded = statFileIdentity(path);
    expect(isOwnedSocketFile(recorded, path)).toBe(true);
    expect(isOwnedSocketFile({ ...recorded, ino: recorded.ino + 1n }, path)).toBe(false);
    expect(isOwnedSocketFile(null, path)).toBe(false);
    expect(isOwnedSocketFile(recorded, join(dir, "missing"))).toBe(false);
  });

  describe("classifySocketPath", () => {
    const recorded = { dev: 7n, ino: 9n };
    const errno = (code: string) => Object.assign(new Error(code), { code });
    const fsWith = (stat: () => { dev: bigint; ino: bigint }, exists = true) => ({
      exists: () => exists,
      stat,
    });

    test("owned when the path still holds the recorded file", () => {
      expect(
        classifySocketPath(
          recorded,
          "p",
          fsWith(() => recorded),
        ),
      ).toBe("owned");
    });

    test("gone when nothing exists at the path", () => {
      expect(
        classifySocketPath(
          recorded,
          "p",
          fsWith(() => recorded, false),
        ),
      ).toBe("gone");
    });

    test("replaced when the path holds a different file", () => {
      const other = { dev: 7n, ino: 10n };
      expect(
        classifySocketPath(
          recorded,
          "p",
          fsWith(() => other),
        ),
      ).toBe("replaced");
    });

    test("replaced when the identity was never recorded but the path is readable now", () => {
      expect(
        classifySocketPath(
          null,
          "p",
          fsWith(() => recorded),
        ),
      ).toBe("replaced");
    });

    test("gone when a recorded path is unlinked between the exists check and the stat", () => {
      const raced = fsWith(() => {
        throw errno("ENOENT");
      });
      expect(classifySocketPath(recorded, "p", raced)).toBe("gone");
    });

    test("replaced when a recorded identity can no longer be read", () => {
      const denied = fsWith(() => {
        throw errno("EACCES");
      });
      expect(classifySocketPath(recorded, "p", denied)).toBe("replaced");
    });

    // Windows with Bun 1.4.4: stat of a bound AF_UNIX path throws EACCES, so no identity is
    // ever recorded and ownership can be neither proven nor disproven (#15035).
    test("unverifiable when stat is denied and no identity was ever recorded", () => {
      for (const code of ["EACCES", "EBUSY", "EPERM"]) {
        const denied = fsWith(() => {
          throw errno(code);
        });
        expect(classifySocketPath(null, "p", denied)).toBe("unverifiable");
      }
    });

    test("gone when stat reports the path missing and no identity was recorded", () => {
      const missing = fsWith(() => {
        throw errno("ENOENT");
      });
      expect(classifySocketPath(null, "p", missing)).toBe("gone");
    });
  });
});
