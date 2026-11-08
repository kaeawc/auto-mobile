import { describe, expect, test } from "bun:test";
import { extractedFileMode } from "../../../src/utils/workers/extractedFileMode";

describe("extractedFileMode (#17216)", function () {
  test("keeps an archive executable runnable, owner-only", function () {
    expect(extractedFileMode(0o755)).toBe(0o700);
    expect(extractedFileMode(0o100)).toBe(0o700);
    expect(extractedFileMode(0o001)).toBe(0o700);
  });

  test("makes non-executable entries owner read/write only", function () {
    expect(extractedFileMode(0o644)).toBe(0o600);
    expect(extractedFileMode(0o666)).toBe(0o600);
  });

  test("treats an entry without unix mode bits as non-executable", function () {
    expect(extractedFileMode(0)).toBe(0o600);
  });
});
