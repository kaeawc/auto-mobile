import { describe, expect, test } from "bun:test";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
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
});
