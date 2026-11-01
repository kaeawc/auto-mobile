import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  readFileIdentity,
  systemImageMetadataPath,
  userdataImagePath,
} from "../../../src/features/snapshot/hostAvdFixtureIdentityProbe";

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

describe("systemImageMetadataPath", () => {
  test("an absolute image path needs no SDK root", () => {
    expect(systemImageMetadataPath("/sdk/system-images/android-35/x86_64", undefined)).toBe(
      join("/sdk/system-images/android-35/x86_64", "source.properties"),
    );
  });

  test("a relative image path resolves against the SDK root", () => {
    expect(systemImageMetadataPath("system-images/android-35/x86_64/", "/sdk")).toBe(
      resolve("/sdk", "system-images/android-35/x86_64/", "source.properties"),
    );
  });

  test("a relative image path without an SDK root is refused", () => {
    expect(() => systemImageMetadataPath("system-images/android-35/x86_64/", undefined)).toThrow(
      "system-image metadata",
    );
  });
});

describe("userdataImagePath", () => {
  test("defaults to the AVD's own userdata image", () => {
    expect(userdataImagePath("/avd/pixel.avd", undefined)).toBe(
      join("/avd/pixel.avd", "userdata-qemu.img"),
    );
    expect(userdataImagePath("/avd/pixel.avd", '["-gpu","swiftshader"]')).toBe(
      join("/avd/pixel.avd", "userdata-qemu.img"),
    );
  });

  test("follows a -data override in AUTOMOBILE_EMULATOR_ARGS, which is the image -wipe-data wipes", () => {
    expect(userdataImagePath("/avd/pixel.avd", '["-data","/scratch/userdata.img"]')).toBe(
      "/scratch/userdata.img",
    );
  });

  test("a -data override without a path is refused rather than read from the default", () => {
    expect(() => userdataImagePath("/avd/pixel.avd", '["-data"]')).toThrow("-data");
  });
});
