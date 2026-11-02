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
import type { ExecResult } from "../../../src/models";
import { ActionableError } from "../../../src/models/ActionableError";

class FakeFiles implements MagiskStubFiles {
  writes = new Map<string, string>();
  removed: string[] = [];
  missing = false;
  async readdir(path: string) {
    return path.endsWith("build-tools") ? ["9.0.0", "35.0.0"] : ["android-9", "android-35"];
  }
  async access() {
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
  test("builds a no-code manifest, signs with only a private throwaway key, and disposes", async () => {
    const files = new FakeFiles();
    const host = new FakeHost();
    const signal = new AbortController().signal;
    const apk = await new DefaultMagiskStubBuilder(host, files, "/sdk").build(signal);
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
      new DefaultMagiskStubBuilder(host, new FakeFiles(), "").build(),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(host.calls).toEqual([]);
  });

  test("missing tools explain SDK setup and run no build commands", async () => {
    const files = new FakeFiles();
    files.missing = true;
    const host = new FakeHost();
    await expect(new DefaultMagiskStubBuilder(host, files, "/sdk").build()).rejects.toThrow(
      /ANDROID_HOME/,
    );
    expect(host.calls).toEqual([]);
  });

  test("failed build cleans up its temporary directory and surfaces an actionable error", async () => {
    const files = new FakeFiles();
    const host = new FakeHost();
    host.fail = true;
    await expect(new DefaultMagiskStubBuilder(host, files, "/sdk").build()).rejects.toThrow(
      /build command failed/,
    );
    expect(files.removed).toEqual(["/fake/private-temp"]);
  });
});
