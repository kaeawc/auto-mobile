import { describe, expect, test } from "bun:test";
import { promises as fsPromises } from "node:fs";
import * as path from "node:path";
import type { SecurePermissions } from "../../src/utils/filesystem/securePermissions";

export interface SecurePermissionsHandle {
  permissions: SecurePermissions;
  /** A private, empty directory the contract may create entries under. */
  root: string;
  dispose?: () => Promise<void>;
}

/**
 * Shared behavioural contract for {@link SecurePermissions} (#11868). The mode bits themselves are
 * deliberately not asserted: the spy fake exists so tests need not depend on POSIX modes (absent on
 * windows-latest), and the real helper skips chmod there. What both must agree on is the observable
 * filesystem effect and the best-effort failure semantics.
 */
export const runSecurePermissionsContract = (
  description: string,
  setup: () => Promise<SecurePermissionsHandle>,
): void => {
  const withHandle = async (body: (handle: SecurePermissionsHandle) => Promise<void>) => {
    const handle = await setup();
    try {
      await body(handle);
    } finally {
      await handle.dispose?.();
    }
  };

  describe(`SecurePermissions contract: ${description}`, function () {
    test("ensureSecureDir creates a nested directory tree", async () => {
      await withHandle(async ({ permissions, root }) => {
        const dir = path.join(root, "a", "b", "c");

        await permissions.ensureSecureDir(dir);

        expect((await fsPromises.stat(dir)).isDirectory()).toBe(true);
      });
    });

    test("ensureSecureDir is idempotent and keeps existing contents", async () => {
      await withHandle(async ({ permissions, root }) => {
        const dir = path.join(root, "existing");
        await permissions.ensureSecureDir(dir);
        await fsPromises.writeFile(path.join(dir, "keep.txt"), "x");

        await permissions.ensureSecureDir(dir);

        expect(await fsPromises.readFile(path.join(dir, "keep.txt"), "utf8")).toBe("x");
      });
    });

    test("ensureSecureDir rejects when the path is an existing file", async () => {
      await withHandle(async ({ permissions, root }) => {
        const file = path.join(root, "file.txt");
        await fsPromises.writeFile(file, "x");

        await expect(permissions.ensureSecureDir(file)).rejects.toThrow();
      });
    });

    test("secureFile leaves an existing file readable by the owner with its contents intact", async () => {
      await withHandle(async ({ permissions, root }) => {
        const file = path.join(root, "secret.bin");
        await fsPromises.writeFile(file, "payload");

        await permissions.secureFile(file);

        expect(await fsPromises.readFile(file, "utf8")).toBe("payload");
      });
    });

    test("secureFile on a missing file is best-effort and does not throw or create it", async () => {
      await withHandle(async ({ permissions, root }) => {
        const file = path.join(root, "missing.bin");

        await expect(permissions.secureFile(file)).resolves.toBeUndefined();

        await expect(fsPromises.stat(file)).rejects.toThrow();
      });
    });
  });
};
