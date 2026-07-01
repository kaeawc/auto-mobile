import { describe, expect, test } from "bun:test";
import { classifyDatabaseFailure } from "../../src/db/databaseFailureClassification";

describe("classifyDatabaseFailure", () => {
  test("classifies a locked/busy sqlite file as transient", () => {
    expect(classifyDatabaseFailure(new Error("SQLITE_BUSY: database is locked"))).toBe("transient");
    expect(classifyDatabaseFailure(new Error("database is locked"))).toBe("transient");
  });

  test("classifies EBUSY/EAGAIN file contention as transient", () => {
    expect(classifyDatabaseFailure(new Error("EBUSY: resource busy or locked"))).toBe("transient");
    expect(classifyDatabaseFailure(new Error("EAGAIN: resource temporarily unavailable"))).toBe("transient");
  });

  test("classifies a full disk as permanent (ENOSPC needs external cleanup, reproduces on respawn)", () => {
    expect(classifyDatabaseFailure(new Error("ENOSPC: no space left on device"))).toBe("permanent");
    expect(classifyDatabaseFailure(new Error("SQLITE_FULL: database or disk is full"))).toBe("permanent");
  });

  test("classifies a corrupt/malformed database as permanent", () => {
    expect(classifyDatabaseFailure(new Error("database disk image is malformed"))).toBe("permanent");
    expect(classifyDatabaseFailure(new Error("file is not a database"))).toBe("permanent");
  });

  test("classifies a deterministic migration throw as permanent", () => {
    expect(classifyDatabaseFailure(new Error("migration 0007 failed: column already exists"))).toBe("permanent");
  });

  test("defaults unknown failures to permanent (fail safe against hot loops)", () => {
    expect(classifyDatabaseFailure("weird string")).toBe("permanent");
    expect(classifyDatabaseFailure(undefined)).toBe("permanent");
  });
});
