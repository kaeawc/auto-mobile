import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AMBIENT_ENV, readEnvRaw } from "../../config/env";
import { quoteForWindowsCmd } from "../../utils/android-cmdline-tools/SdkManagerClient";
import { DefaultSystemDetection, type SystemDetection } from "../../utils/system/SystemDetection";
import { adbCommand, shell } from "./injectorSupport";
import { logger } from "../../utils/logger";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../utils/HostCommandExecutor";

export const MAGISK_PACKAGE = "com.topjohnwu.magisk";
export interface MagiskStubApk {
  path: string;
  dispose(): Promise<void>;
}
export interface MagiskStubBuilder {
  build(signal?: AbortSignal): Promise<MagiskStubApk>;
}

/** No executable code, components, permissions, or real root functionality. */
export const MAGISK_STUB_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.topjohnwu.magisk" android:versionCode="1" android:versionName="1">
  <uses-sdk android:minSdkVersion="23" android:targetSdkVersion="28" />
  <application android:hasCode="false" android:label="AutoMobile root detection fixture" />
</manifest>`;

export interface MagiskStubFiles {
  readdir(path: string): Promise<string[]>;
  access(path: string): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
}

/** Build exclusively from ANDROID_HOME; never consult user signing or Gradle configuration. */
export class DefaultMagiskStubBuilder implements MagiskStubBuilder {
  constructor(
    private readonly host: HostCommandExecutor = new DefaultHostCommandExecutor(),
    private readonly files: MagiskStubFiles = fs,
    private readonly sdkRoot = readEnvRaw(AMBIENT_ENV.ANDROID_HOME),
    private readonly systemDetection: Pick<
      SystemDetection,
      "getCurrentPlatform"
    > = new DefaultSystemDetection(),
  ) {}

  async build(signal?: AbortSignal): Promise<MagiskStubApk> {
    let directory: string | undefined;
    try {
      if (!this.sdkRoot) {
        throw new ActionableError(
          "Set ANDROID_HOME to an Android SDK with build-tools (aapt2 and apksigner), a platform android.jar, and a JDK (keytool) to apply rootState.",
        );
      }
      const latest = async (parent: string): Promise<string> => {
        const versions = (await this.files.readdir(parent)).sort((a, b) =>
          b.localeCompare(a, "en", { numeric: true }),
        );
        if (!versions[0]) {
          throw new ActionableError(
            `Install Android SDK build-tools and a platform under ANDROID_HOME; ${parent} is empty.`,
          );
        }
        return join(parent, versions[0]);
      };
      const tools = await latest(join(this.sdkRoot, "build-tools"));
      const platform = await latest(join(this.sdkRoot, "platforms"));
      const windows = this.systemDetection.getCurrentPlatform() === "win32";
      const aapt = join(tools, windows ? "aapt2.exe" : "aapt2");
      const signer = join(tools, windows ? "apksigner.bat" : "apksigner");
      const androidJar = join(platform, "android.jar");
      await Promise.all([aapt, signer, androidJar].map((path) => this.files.access(path)));
      directory = await this.files.mkdtemp(join(tmpdir(), "automobile-magisk-stub-"));
      const manifest = join(directory, "AndroidManifest.xml");
      const unsigned = join(directory, "unsigned.apk");
      const path = join(directory, "magisk-stub.apk");
      const keystore = join(directory, "throwaway.p12");
      await this.files.writeFile(manifest, MAGISK_STUB_MANIFEST);
      const run = async (file: string, args: string[]): Promise<void> => {
        if (windows && file === signer) {
          args = [
            "/d",
            "/v:off",
            "/s",
            "/c",
            `"${[quoteForWindowsCmd(file), ...args.map(quoteForWindowsCmd)].join(" ")}"`,
          ];
          file = readEnvRaw(AMBIENT_ENV.COMSPEC) ?? "cmd.exe";
        }
        const result = await this.host.executeCommand(file, args, { signal, timeoutMs: 30_000 });
        if (result.error) {
          throw new ActionableError(`rootState stub build failed: ${result.error}`);
        }
      };
      await run(aapt, ["link", "-o", unsigned, "--manifest", manifest, "-I", androidJar]);
      await run("keytool", [
        "-genkeypair",
        "-keystore",
        keystore,
        "-storetype",
        "PKCS12",
        "-storepass",
        "automobile-fixture",
        "-keypass",
        "automobile-fixture",
        "-alias",
        "fixture",
        "-keyalg",
        "RSA",
        "-keysize",
        "2048",
        "-validity",
        "1",
        "-dname",
        "CN=AutoMobile Fixture",
        "-noprompt",
      ]);
      await run(signer, [
        "sign",
        "--ks",
        keystore,
        "--ks-pass",
        "pass:automobile-fixture",
        "--out",
        path,
        unsigned,
      ]);
      const ownedDirectory = directory;
      return {
        path,
        dispose: () => this.files.rm(ownedDirectory, { recursive: true, force: true }),
      };
    } catch (error) {
      if (directory) {
        try {
          await this.files.rm(directory, { recursive: true, force: true });
        } catch (cleanupError) {
          logger.warn("rootState stub temporary directory cleanup failed", cleanupError);
          throw toActionableError(
            cleanupError,
            `Could not remove rootState stub temporary directory ${directory} after build failure`,
          );
        }
      }
      throw toActionableError(
        error,
        "Could not build the rootState Magisk stub; install Android SDK build-tools (aapt2/apksigner), a platform and JDK keytool, and set ANDROID_HOME",
      );
    }
  }
}

/** Package operations stay separate from file operations while using the same ownership key. */
export function createMagiskPackageArtifact(adb: AdbExecutor, builder: MagiskStubBuilder) {
  return {
    key: `package:${MAGISK_PACKAGE}`,

    async present(signal?: AbortSignal): Promise<boolean> {
      return (await shell(adb, ["pm", "list", "packages", MAGISK_PACKAGE], signal))
        .split("\n")
        .includes(this.key);
    },

    async apply(
      hadPackage: boolean,
      claim: (planted: boolean) => void,
      signal?: AbortSignal,
    ): Promise<void> {
      if (hadPackage) {
        claim(false);
        return;
      }
      const apk = await builder.build(signal);
      try {
        // Claim before install: cancellation can arrive after PackageManager commits it.
        claim(true);
        const output = await adbCommand(adb, ["install", "-r", apk.path], signal);
        if (/Failure|Error:/i.test(output) || !(await this.present(signal))) {
          throw new ActionableError(`Could not install rootState Magisk stub: ${output}`);
        }
      } finally {
        await apk.dispose();
      }
    },

    /** True if removal read-back still finds the package. Missing packages need no uninstall. */
    async remove(signal?: AbortSignal): Promise<boolean> {
      if (!(await this.present(signal))) {
        return false;
      }
      const output = await adbCommand(adb, ["uninstall", MAGISK_PACKAGE], signal);
      if (/Failure|Error:/i.test(output)) {
        throw new ActionableError(`Could not uninstall rootState Magisk stub: ${output}`);
      }
      return this.present(signal);
    },
  };
}
