import { describe, expect, test } from "bun:test";
import { resolveAndroidDatabasePath } from "../../../src/features/database/androidDatabasePath";

describe("resolveAndroidDatabasePath", () => {
  test.each(["sessions.db", "sessions", ".hidden.db", "a b.db", " sessions.db "])(
    "resolves bare name %s without trimming",
    (name) => {
      expect(resolveAndroidDatabasePath("com.example.app", name)).toBe(
        `/data/data/com.example.app/databases/${name}`,
      );
    },
  );

  test.each([
    "",
    ".",
    "..",
    "/data/data/com.example.app/databases/sessions.db",
    "./sessions.db",
    "../sessions.db",
    "nested/sessions.db",
    "nested\\sessions.db",
    "C:\\sessions.db",
  ])("preserves non-bare path %s", (path) => {
    expect(resolveAndroidDatabasePath("com.example.app", path)).toBe(path);
  });
});
