import { describe, expect, test, afterEach } from "bun:test";
import { resolveImageBackend } from "../../../../src/utils/image/backend/resolveImageBackend";
import { JimpBackend } from "../../../../src/utils/image/backend/JimpBackend";
import { JimpCliBackend } from "../../../../src/utils/image/backend/JimpCliBackend";
import { SharpBackend } from "../../../../src/utils/image/backend/SharpBackend";

describe("resolveImageBackend", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    // Keep `configurable: true` explicit so a future runtime that defaults it to
    // false on redefine can't wedge process.platform for the rest of the run.
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  test("returns a backend on the current platform", () => {
    const backend = resolveImageBackend();
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(backend).toBeInstanceOf(SharpBackend);
    } else if (process.platform === "win32") {
      expect(backend).toBeInstanceOf(JimpCliBackend);
    } else {
      expect(backend).toBeInstanceOf(JimpBackend);
    }
  });

  test("returns JimpCliBackend on Windows", () => {
    expect(resolveImageBackend({ platform: "win32" })).toBeInstanceOf(JimpCliBackend);
  });

  test("returns SharpBackend on macOS and Linux", () => {
    expect(resolveImageBackend({ platform: "darwin" })).toBeInstanceOf(SharpBackend);
    expect(resolveImageBackend({ platform: "linux" })).toBeInstanceOf(SharpBackend);
  });

  test("returns a fresh instance per call", () => {
    expect(resolveImageBackend()).not.toBe(resolveImageBackend());
  });
});
