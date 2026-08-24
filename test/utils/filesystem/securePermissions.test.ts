import { afterEach, describe, expect, test } from "bun:test";
import { promises as fsPromises, statSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  SECURE_DIR_MODE,
  SECURE_FILE_MODE,
  ensureSecureDir,
  secureFile,
  defaultSecurePermissions,
} from "../../../src/utils/filesystem/securePermissions";

const isWindows = platform() === "win32";
const created: string[] = [];

function tempPath(prefix: string): string {
  const p = join(tmpdir(), `${prefix}-${randomUUID()}`);
  created.push(p);
  return p;
}

afterEach(async () => {
  for (const p of created.splice(0)) {
    await fsPromises.rm(p, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("securePermissions", () => {
  test("exposes the owner-only mode constants", () => {
    expect(SECURE_DIR_MODE).toBe(0o700);
    expect(SECURE_FILE_MODE).toBe(0o600);
  });

  test("defaultSecurePermissions is backed by the real helpers", () => {
    expect(defaultSecurePermissions.ensureSecureDir).toBe(ensureSecureDir);
    expect(defaultSecurePermissions.secureFile).toBe(secureFile);
  });

  test("ensureSecureDir creates a directory recursively", async () => {
    const dir = tempPath("secure-dir");
    const nested = join(dir, "a", "b");

    await ensureSecureDir(nested);

    expect(statSync(nested).isDirectory()).toBe(true);
  });

  (isWindows ? test.skip : test)("ensureSecureDir sets 0o700 on the directory", async () => {
    const dir = tempPath("secure-dir-mode");

    await ensureSecureDir(dir);

    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  (isWindows ? test.skip : test)(
    "ensureSecureDir repairs a pre-existing loose directory",
    async () => {
      const dir = tempPath("secure-dir-repair");
      await fsPromises.mkdir(dir, { recursive: true, mode: 0o755 });

      await ensureSecureDir(dir);

      expect(statSync(dir).mode & 0o777).toBe(0o700);
    },
  );

  (isWindows ? test.skip : test)("secureFile sets 0o600 on the file", async () => {
    const dir = tempPath("secure-file");
    await fsPromises.mkdir(dir, { recursive: true });
    const file = join(dir, "recording.mp4");
    await fsPromises.writeFile(file, "data", { mode: 0o644 });

    await secureFile(file);

    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("secureFile swallows a missing-file error (best-effort)", async () => {
    const missing = join(tempPath("secure-missing"), "nope.mp4");

    await expect(secureFile(missing)).resolves.toBeUndefined();
  });
});
