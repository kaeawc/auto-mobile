import Ajv2020 from "ajv/dist/2020";
import { beforeAll, describe, expect, test } from "bun:test";
import { stageSessionDownloadsSchema } from "../../src/server/downloadsFixtureContract";

describe("stageSessionDownloads contract (#7007)", () => {
  beforeAll(() => {
    // Absorb Ajv's one-time JIT cold start in setup, off the per-test budget.
    new Ajv2020({ strict: false }).compile({
      type: "object",
      properties: { warmup: { type: "string" } },
    });
  });

  test("parses a minimal request and defaults reset/indexMedia", () => {
    const parsed = stageSessionDownloadsSchema.parse({
      sessionUuid: "session-1",
      directory: "run-42",
      files: [{ contentText: "fixture", destinationPath: "fixture.txt" }],
    });
    expect(parsed).toMatchObject({ reset: false, indexMedia: true });
  });

  test("requires sessionUuid and at least one file", () => {
    expect(
      stageSessionDownloadsSchema.safeParse({
        directory: "run-42",
        files: [{ contentText: "x", destinationPath: "a.txt" }],
      }).success,
    ).toBe(false);
    expect(
      stageSessionDownloadsSchema.safeParse({
        sessionUuid: "session-1",
        directory: "run-42",
        files: [],
      }).success,
    ).toBe(false);
  });

  test("rejects a directory with path separators or traversal", () => {
    for (const directory of ["../escape", "a/b", "..", "."]) {
      expect(
        stageSessionDownloadsSchema.safeParse({
          sessionUuid: "session-1",
          directory,
          files: [{ contentText: "x", destinationPath: "a.txt" }],
        }).success,
      ).toBe(false);
    }
  });

  test("rejects absolute and traversal destinationPath values", () => {
    for (const destinationPath of ["/etc/passwd", "../secret.txt", "docs/../../escape.txt"]) {
      expect(
        stageSessionDownloadsSchema.safeParse({
          sessionUuid: "session-1",
          directory: "run-42",
          files: [{ contentText: "x", destinationPath }],
        }).success,
      ).toBe(false);
    }
  });
});
