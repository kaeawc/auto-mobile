import { describe, expect, test } from "bun:test";
import AdmZip from "adm-zip";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  baseApkEntryName,
  DefaultAndroidArtifactHost,
} from "../../../src/features/action/AndroidArtifactHost";
import { useScratchRoot } from "../../helpers/scratchRoot";

describe("baseApkEntryName", () => {
  test("prefers the base master split, then a universal APK, then a standalone", () => {
    expect(baseApkEntryName(["toc.pb", "splits/base-xxhdpi.apk", "splits/base-master.apk"])).toBe(
      "splits/base-master.apk",
    );
    expect(baseApkEntryName(["toc.pb", "splits/base-master_2.apk"])).toBe(
      "splits/base-master_2.apk",
    );
    expect(baseApkEntryName(["universal.apk", "standalones/standalone-x86.apk"])).toBe(
      "universal.apk",
    );
    expect(baseApkEntryName(["standalones/standalone-x86_64.apk"])).toBe(
      "standalones/standalone-x86_64.apk",
    );
    expect(baseApkEntryName(["toc.pb", "splits/feature-master.apk"])).toBeUndefined();
  });
});

describe("DefaultAndroidArtifactHost", () => {
  const scratch = useScratchRoot("automobile-artifact-host-");
  const host = new DefaultAndroidArtifactHost();

  test("extracts only the base split to the requested path", async () => {
    const dir = scratch.next();
    const apkSet = path.join(dir, "app.apks");
    const zip = new AdmZip();
    zip.addFile("toc.pb", Buffer.from("toc"));
    zip.addFile("splits/base-master.apk", Buffer.from("base bytes"));
    zip.addFile("splits/feature-master.apk", Buffer.from("feature bytes"));
    zip.writeZip(apkSet);
    const destination = path.join(dir, "base.apk");

    expect(await host.extractBaseApk(apkSet, destination)).toBe(true);
    expect(readFileSync(destination, "utf8")).toBe("base bytes");
  });

  test("reports an APK set without a base split", async () => {
    const dir = scratch.next();
    const apkSet = path.join(dir, "app.apks");
    const zip = new AdmZip();
    zip.addFile("toc.pb", Buffer.from("toc"));
    zip.writeZip(apkSet);

    expect(await host.extractBaseApk(apkSet, path.join(dir, "base.apk"))).toBe(false);
  });

  test("lists only the APK files of a split directory, sorted", async () => {
    const dir = scratch.next();
    writeFileSync(path.join(dir, "split_config.arm64_v8a.apk"), "");
    writeFileSync(path.join(dir, "base.apk"), "");
    writeFileSync(path.join(dir, "notes.txt"), "");
    mkdirSync(path.join(dir, "nested.apk"));

    expect(await host.isDirectory(dir)).toBe(true);
    expect(await host.isDirectory(path.join(dir, "base.apk"))).toBe(false);
    expect(await host.isDirectory(path.join(dir, "missing"))).toBe(false);
    expect(await host.listApks(dir)).toEqual([
      path.join(dir, "base.apk"),
      path.join(dir, "split_config.arm64_v8a.apk"),
    ]);
  });

  test("writes secrets without a newline and readable only by the owner", async () => {
    const target = path.join(scratch.next(), "ks-pass");
    await host.writeSecretFile(target, "hunter2");

    expect(readFileSync(target, "utf8")).toBe("hunter2");
    if (process.platform !== "win32") {
      expect(statSync(target).mode & 0o777).toBe(0o600);
    }
    // Refuses to overwrite an existing file rather than following it.
    await expect(host.writeSecretFile(target, "again")).rejects.toThrow();
  });
});
