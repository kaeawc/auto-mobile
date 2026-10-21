import { describe, expect, test } from "bun:test";
import { sameSample, toSample } from "../../src/utils/fileLock/contracts";
import { guardPrefix } from "../../src/utils/fileLock/reclaimGuard";
import { mtimeMsFromNs } from "../../src/utils/lockFileSystem";

// NTFS file IDs exceed Number.MAX_SAFE_INTEGER; these two differ by one but round to one number.
const ID = 12_947_848_930_067_504n;
const NEXT_ID = ID + 1n;

describe("lock inode identity", () => {
  test("the two ids are indistinguishable as numbers", () => {
    expect(Number(ID)).toBe(Number(NEXT_ID));
  });

  test("samples of distinct files whose ids round alike are not the same sample", () => {
    const sample = { ino: ID, mtimeMs: 1, raw: "100\nowner" };
    expect(sameSample(sample, { ...sample })).toBe(true);
    expect(sameSample(sample, { ...sample, ino: NEXT_ID })).toBe(false);
  });

  test("a publication without identity never matches a sample", () => {
    const sample = toSample({ raw: "100\nowner" });
    expect(sameSample(sample, sample)).toBe(false);
  });

  test("the reclaim guard keeps the rounded number spelling released versions write", () => {
    const sample = { ino: NEXT_ID, mtimeMs: 1_700_000_000_123.456, raw: "100\nowner" };
    expect(guardPrefix("/locks/a.lock", sample)).toStartWith(
      `/locks/a.lock.reclaim.${Number(NEXT_ID)}.1700000000123.456.`,
    );
  });

  test("mtimeMsFromNs reproduces the number Stats.mtimeMs formula", () => {
    expect(mtimeMsFromNs(0n)).toBe(0);
    expect(mtimeMsFromNs(1_700_000_000_123_456_789n)).toBe(
      1_700_000_000 * 1000 + 123_456_789 / 1e6,
    );
    expect(mtimeMsFromNs(1_000_000n)).toBe(1);
  });
});
