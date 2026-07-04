import { describe, expect, test, afterEach } from "bun:test";
import { resolveImageBackend } from "../../../../src/utils/image/backend/resolveImageBackend";
import { JimpBackend } from "../../../../src/utils/image/backend/JimpBackend";

describe("resolveImageBackend", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  test("returns a JimpBackend on the current platform", () => {
    expect(resolveImageBackend()).toBeInstanceOf(JimpBackend);
  });

  test("returns a JimpBackend on every platform (selection logic lands later)", () => {
    for (const platform of ["win32", "darwin", "linux"]) {
      Object.defineProperty(process, "platform", { value: platform });
      expect(resolveImageBackend()).toBeInstanceOf(JimpBackend);
    }
  });

  test("returns a fresh instance per call", () => {
    expect(resolveImageBackend()).not.toBe(resolveImageBackend());
  });
});
