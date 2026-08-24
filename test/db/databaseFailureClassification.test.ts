import { describe, expect, test } from "bun:test";
import {
  classifyDatabaseFailure,
  type DatabaseFailureKind,
} from "../../src/db/databaseFailureClassification";
import { createIncompleteExtractionError } from "../../src/db/migrationDependencyIntegrity";

describe("classifyDatabaseFailure", () => {
  test.each<[string, unknown, DatabaseFailureKind]>([
    // Transient: busy/locked contention that a fast restart may clear.
    ["SQLITE_BUSY message", new Error("SQLITE_BUSY: database is locked"), "transient"],
    ["database is locked", new Error("database is locked"), "transient"],
    ["database table is locked", new Error("database table is locked"), "transient"],
    ["EBUSY message", new Error("EBUSY: resource busy or locked"), "transient"],
    ["EAGAIN message", new Error("EAGAIN: resource temporarily unavailable"), "transient"],
    [
      "resource temporarily unavailable",
      new Error("resource temporarily unavailable"),
      "transient",
    ],

    // Permanent: needs external intervention and reproduces on respawn.
    ["ENOSPC full disk", new Error("ENOSPC: no space left on device"), "permanent"],
    ["SQLITE_FULL", new Error("SQLITE_FULL: database or disk is full"), "permanent"],
    ["malformed disk image", new Error("database disk image is malformed"), "permanent"],
    ["file is not a database", new Error("file is not a database"), "permanent"],
    [
      "deterministic migration throw",
      new Error("migration 0007 failed: column already exists"),
      "permanent",
    ],
    ["incomplete extraction (constructed)", createIncompleteExtractionError("kysely"), "permanent"],
    [
      "cannot find package",
      new Error("Cannot find package 'kysely' from '/tmp/x/m.ts'"),
      "permanent",
    ],

    // Unknown / non-Error inputs default to permanent (fail-safe against hot loops).
    ["non-error string", "weird string", "permanent"],
    ["undefined", undefined, "permanent"],
    ["null", null, "permanent"],

    // error.code participates in the haystack (databaseFailureClassification.ts:29-30):
    // a transient CODE with an otherwise-unrelated message must still be transient,
    // else `{code:"EBUSY"}` contention is misclassified permanent and the daemon
    // backs off instead of restarting.
    [
      "EBUSY code, unrelated message",
      Object.assign(new Error("startup failed"), { code: "EBUSY" }),
      "transient",
    ],
    [
      "SQLITE_BUSY code, unrelated message",
      Object.assign(new Error("boot error"), { code: "SQLITE_BUSY" }),
      "transient",
    ],
    [
      "EAGAIN code, unrelated message",
      Object.assign(new Error("nope"), { code: "EAGAIN" }),
      "transient",
    ],
    [
      "ENOSPC code, unrelated message",
      Object.assign(new Error("boot error"), { code: "ENOSPC" }),
      "permanent",
    ],

    // A non-string code is ignored; classification falls back to the message.
    [
      "numeric code ignored, message is transient",
      Object.assign(new Error("database is locked"), { code: 42 }),
      "transient",
    ],
    [
      "numeric code ignored, message is permanent",
      Object.assign(new Error("boot error"), { code: 42 }),
      "permanent",
    ],
  ])("classifies %s", (_label, input, expected) => {
    expect(classifyDatabaseFailure(input)).toBe(expected);
  });
});
