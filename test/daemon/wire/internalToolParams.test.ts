import { describe, expect, test } from "bun:test";
import { internalRequesterSessionUuid } from "../../../src/daemon/wire/internalToolParams";

describe("shared internal tool parameter readers", () => {
  test.each([["__requesterSessionUuid", internalRequesterSessionUuid]] as const)(
    "%s reads strings without normalizing them",
    (key, read) => {
      expect(read({ [key]: "identity" })).toBe("identity");
      expect(read({ [key]: "" })).toBe("");
      expect(read({})).toBeUndefined();
      for (const value of [undefined, null, true, 42, {}, []]) {
        expect(read({ [key]: value })).toBeUndefined();
      }
    },
  );
});
