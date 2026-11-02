import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DefaultMagiskStubBuilder,
  MAGISK_STUB_MANIFEST,
  type MagiskStubFiles,
} from "../../../src/features/deviceCondition/magiskStub";
import type {
  HostCommandExecutor,
  HostCommandOptions,
} from "../../../src/utils/HostCommandExecutor";
import type { SystemDetection } from "../../../src/utils/system/SystemDetection";
import type { ExecResult } from "../../../src/models";
import { ActionableError } from "../../../src/models/ActionableError";
import { AMBIENT_ENV, readEnvRaw } from "../../../src/config/env";

const linuxSystemDetection: Pick<SystemDetection, "getCurrentPlatform"> = {
  getCurrentPlatform: () => "linux",
};

class FakeFiles implements MagiskStubFiles {
  writes = new Map<string, string>();
  removed: string[] = [];
  missing = false;
  async readdir(path: string) {
    return path.endsWith("build-tools") ? ["9.0.0", "35.0.0"] : ["android-9", "android-35"];
  }
  async access(_path: string) {
    if (this.missing) {
      throw new Error("SDK tool missing");
    }
  }
  async mkdtemp() {
    return "/fake/private-temp";
  }
  async writeFile(path: string, contents: string) {
    this.writes.set(path, contents);
  }
  async rm(path: string) {
    this.removed.push(path);
  }
}
class WindowsFakeFiles extends FakeFiles {
  accessed: string[] = [];
  constructor(private readonly sdkRoot: string) {
    super();
  }
  override async access(path: string) {
    this.accessed.push(path);
    if (
      ![
        join(this.sdkRoot, "build-tools", "35.0.0", "aapt2.exe"),
        join(this.sdkRoot, "build-tools", "35.0.0", "apksigner.bat"),
        join(this.sdkRoot, "platforms", "android-35", "android.jar"),
      ].includes(path)
    ) {
      throw new Error(`SDK tool missing: ${path}`);
    }
  }
}
class FakeHost implements HostCommandExecutor {
  calls: { file: string; args: string[]; options?: HostCommandOptions }[] = [];
  fail = false;
  async executeCommand(
    file: string,
    args: string[] = [],
    options?: HostCommandOptions,
  ): Promise<ExecResult> {
    this.calls.push({ file, args, options });
    if (this.fail) {
      throw new Error("build command failed");
    }
    return { stdout: "", stderr: "", toString: () => "", trim: () => "", includes: () => false };
  }
}

describe("Magisk stub builder", () => {
  test("Windows finds suffixed tools, runs aapt2 directly, and signs through COMSPEC", async () => {
    const sdkRoot = "C:/Android SDK";
    const files = new WindowsFakeFiles(sdkRoot);
    const host = new FakeHost();
    const signal = new AbortController().signal;
    const apk = await new DefaultMagiskStubBuilder(host, files, sdkRoot, {
      getCurrentPlatform: () => "win32",
    }).build(signal);
    const aapt = join(sdkRoot, "build-tools", "35.0.0", "aapt2.exe");
    const signer = join(sdkRoot, "build-tools", "35.0.0", "apksigner.bat");
    const androidJar = join(sdkRoot, "platforms", "android-35", "android.jar");
    expect(files.accessed).toEqual([aapt, signer, androidJar]);
    expect(host.calls.map((call) => call.file)).toEqual([
      aapt,
      "keytool",
      readEnvRaw(AMBIENT_ENV.COMSPEC) ?? "cmd.exe",
    ]);
    expect(host.calls[0]?.args).toEqual([
      "link",
      "-o",
      join("/fake/private-temp", "unsigned.apk"),
      "--manifest",
      join("/fake/private-temp", "AndroidManifest.xml"),
      "-I",
      androidJar,
    ]);
    expect(host.calls[2]?.args).toEqual([
      "/d",
      "/v:off",
      "/s",
      "/c",
      `""${signer}" "sign" "--ks" "${join("/fake/private-temp", "throwaway.p12")}" "--ks-pass" "pass:automobile-fixture" "--out" "${apk.path}" "${join("/fake/private-temp", "unsigned.apk")}""`,
    ]);
    expect(host.calls.every((call) => call.options?.signal === signal)).toBe(true);
    await apk.dispose();
    expect(files.removed).toEqual(["/fake/private-temp"]);
  });

  test("Windows signing doubles percent signs in the batch path", async () => {
    const sdkRoot = "C:/%SDK%";
    const host = new FakeHost();
    await new DefaultMagiskStubBuilder(host, new WindowsFakeFiles(sdkRoot), sdkRoot, {
      getCurrentPlatform: () => "win32",
    }).build();
    expect(host.calls[2]?.args[4]).toContain(
      `"${join("C:/%%SDK%%", "build-tools", "35.0.0", "apksigner.bat")}"`,
    );
  });

  test.each(['"', "\r", "\n"])(
    "Windows signing rejects unsafe batch path character %j and cleans up",
    async (character) => {
      const sdkRoot = `C:/SDK${character}`;
      const files = new WindowsFakeFiles(sdkRoot);
      const host = new FakeHost();
      await expect(
        new DefaultMagiskStubBuilder(host, files, sdkRoot, {
          getCurrentPlatform: () => "win32",
        }).build(),
      ).rejects.toThrow(/Windows batch arguments cannot contain command-line quotes or newlines/);
      expect(host.calls).toHaveLength(2);
      expect(files.removed).toEqual(["/fake/private-temp"]);
    },
  );

  test("builds a no-code manifest, signs with only a private throwaway key, and disposes", async () => {
    const files = new FakeFiles();
    const host = new FakeHost();
    const signal = new AbortController().signal;
    const apk = await new DefaultMagiskStubBuilder(host, files, "/sdk", linuxSystemDetection).build(
      signal,
    );
    expect(files.writes.get(join("/fake/private-temp", "AndroidManifest.xml"))).toBe(
      MAGISK_STUB_MANIFEST,
    );
    expect(MAGISK_STUB_MANIFEST).toContain('android:hasCode="false"');
    expect(MAGISK_STUB_MANIFEST).toContain('package="com.topjohnwu.magisk"');
    expect(host.calls.map((call) => call.file)).toEqual([
      join("/sdk", "build-tools", "35.0.0", "aapt2"),
      "keytool",
      join("/sdk", "build-tools", "35.0.0", "apksigner"),
    ]);
    expect(host.calls[0]?.args).toContain(join("/sdk", "platforms", "android-35", "android.jar"));
    expect(host.calls[1]?.args).toContain(join("/fake/private-temp", "throwaway.p12"));
    expect(host.calls.every((call) => call.options?.signal === signal)).toBe(true);
    expect(files.removed).toEqual([]);
    await apk.dispose();
    expect(files.removed).toEqual(["/fake/private-temp"]);
  });

  test("missing SDK configuration is actionable and runs no commands", async () => {
    const host = new FakeHost();
    await expect(
      new DefaultMagiskStubBuilder(host, new FakeFiles(), "", linuxSystemDetection).build(),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(host.calls).toEqual([]);
  });

  test("missing tools explain SDK setup and run no build commands", async () => {
    const files = new FakeFiles();
    files.missing = true;
    const host = new FakeHost();
    await expect(
      new DefaultMagiskStubBuilder(host, files, "/sdk", linuxSystemDetection).build(),
    ).rejects.toThrow(/ANDROID_HOME/);
    expect(host.calls).toEqual([]);
  });

  test("failed build cleans up its temporary directory and surfaces an actionable error", async () => {
    const files = new FakeFiles();
    const host = new FakeHost();
    host.fail = true;
    await expect(
      new DefaultMagiskStubBuilder(host, files, "/sdk", linuxSystemDetection).build(),
    ).rejects.toThrow(/build command failed/);
    expect(files.removed).toEqual(["/fake/private-temp"]);
  });
});
