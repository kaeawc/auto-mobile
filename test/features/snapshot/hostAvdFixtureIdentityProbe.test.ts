import { describe, expect, test } from "bun:test";
import { readFileIdentity } from "../../../src/features/snapshot/hostAvdFixtureIdentityProbe";

const errno = (code: string) => Object.assign(new Error(code), { code });

describe("readFileIdentity (#14065)", () => {
  test("reports the file's inode and birth time", async () => {
    const identity = await readFileIdentity("/avd/userdata-qemu.img", async () => ({
      ino: 42,
      birthtimeMs: 1_730_000_000_000,
    }));

    expect(identity).toEqual({ ino: 42, birthtimeMs: 1_730_000_000_000 });
  });

  test("a missing file is null: the AVD has never booted", async () => {
    expect(
      await readFileIdentity("/avd/userdata-qemu.img", async () => {
        throw errno("ENOENT");
      }),
    ).toBeNull();
  });

  test("any other failure is not mistaken for a never-booted AVD", async () => {
    await expect(
      readFileIdentity("/avd/userdata-qemu.img", async () => {
        throw errno("EACCES");
      }),
    ).rejects.toThrow("EACCES");
  });
});
