import { beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { InstallApp } from "../../../src/features/action/InstallApp";
import type { InstallAppCall } from "../../../src/features/action/InstallAppTypes";
import { SigningGuardError } from "../../../src/models/SigningGuardError";
import { BundletoolNotFoundError } from "../../../src/utils/android-cmdline-tools/BundletoolLocator";
import { createPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAndroidArtifactHost } from "../../fakes/FakeAndroidArtifactHost";
import { FakeAndroidBuildToolsLocator } from "../../fakes/FakeAndroidBuildToolsLocator";
import { FakeBundletoolLocator } from "../../fakes/FakeBundletoolLocator";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import {
  FakePackageSigningInspector,
  signingInspection,
} from "../../fakes/FakePackageSigningInspector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { SIGNER_A } from "../../helpers/signedApkFixtures";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const APP = "com.example.app";
const BUNDLETOOL = "/usr/local/bin/bundletool";
const STORE_PASSWORD = "s3cret-store";
const KEY_PASSWORD = "s3cret-key";

const exec = (stdout: string, stderr = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (search: string) => stdout.includes(search),
});

/** A failed host command as execFile reports it, wrapped like the real executor wraps it. */
function commandFailure(stderr: string, extra: Record<string, unknown> = {}): Error {
  const raw = Object.assign(new Error("Command failed"), { stdout: "", stderr, code: 1 }, extra);
  return new Error(`Command failed: bundletool ...`, { cause: raw });
}

let adb: FakeAdbExecutor;
let host: FakeHostCommandExecutor;
let files: FakeAndroidArtifactHost;
let bundletool: FakeBundletoolLocator;
let timer: FakeTimer;

function build(inspector?: FakePackageSigningInspector): InstallApp {
  const aapt = new FakeAndroidBuildToolsLocator();
  aapt.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
  return new InstallApp(
    device,
    { create: () => adb },
    {
      hostExecutor: host,
      buildToolsLocator: aapt,
      bundletoolLocator: bundletool,
      artifactHost: files,
      performanceTrackerFactory: () => createPerformanceTracker(false, timer),
      timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      ...(inspector ? { signingInspector: inspector } : {}),
    },
  );
}

const hostCalls = (verb: string) =>
  host.getExecutedCalls().filter((call) => call.args.includes(verb));
const argvOf = (verb: string) => hostCalls(verb)[0]?.args ?? [];
const aaptSources = () =>
  host
    .getExecutedCalls()
    .filter((call) => call.command.endsWith("aapt2"))
    .map((call) => call.args.at(-1));

beforeEach(() => {
  adb = new FakeAdbExecutor();
  host = new FakeHostCommandExecutor();
  files = new FakeAndroidArtifactHost();
  bundletool = new FakeBundletoolLocator();
  timer = new FakeTimer();
  timer.enableAutoAdvance();
  adb.setUsers([{ userId: 0, name: "Owner", flags: 0x13, running: true }]);
  // Not installed before; present after the install.
  adb.setCommandResponseSequence("shell pm list packages --user 0", [
    exec(""),
    exec(""),
    exec(`package:${APP}`),
  ]);
  host.setCommandResponse("aapt2", exec(`package: name='${APP}' versionCode='7'`));
});

describe("InstallApp split APKs", () => {
  test("installs the base APK plus explicit splits through install-multiple with -g and -d", async () => {
    adb.setCommandResponse("install-multiple", exec("Success"));
    const call: InstallAppCall = {
      android: {
        splits: ["/apps/split_config.arm64_v8a.apk", "/apps/split_config.xxhdpi.apk"],
        grantAllPermissions: true,
        allowDowngrade: true,
      },
    };

    const result = await build().execute("/apps/base.apk", call);

    expect(result).toMatchObject({
      success: true,
      packageName: APP,
      userId: 0,
      installRoute: "split-apks",
    });
    expect(adb.getExecutedCommands()).toContain(
      'install-multiple --user 0 -r -g -d "/apps/base.apk" "/apps/split_config.arm64_v8a.apk" "/apps/split_config.xxhdpi.apk"',
    );
    expect(aaptSources()).toEqual(["/apps/base.apk"]);
    expect(hostCalls("install-apks")).toEqual([]);
  });

  test("a directory of a base plus ABI splits installs base-first through install-multiple", async () => {
    files.directories.set("/apps/splits", [
      "/apps/splits/a_feature.apk",
      "/apps/splits/base.apk",
      "/apps/splits/split_config.arm64_v8a.apk",
    ]);
    adb.setCommandResponse("install-multiple", exec("Success"));

    const result = await build().execute("/apps/splits");

    expect(result).toMatchObject({ success: true, packageName: APP, installRoute: "split-apks" });
    expect(adb.getExecutedCommands()).toContain(
      'install-multiple --user 0 -r "/apps/splits/base.apk" "/apps/splits/a_feature.apk" "/apps/splits/split_config.arm64_v8a.apk"',
    );
    expect(aaptSources()).toEqual(["/apps/splits/base.apk"]);
  });

  test("a directory without APKs is refused before anything touches the device", async () => {
    files.directories.set("/apps/empty", []);
    await expect(build().execute("/apps/empty")).rejects.toThrow("No .apk files found");
    expect(adb.wasCommandExecuted("install")).toBe(false);
  });

  test("a plain .apk keeps the historical command and result shape", async () => {
    adb.setCommandResponse('install --user 0 -r "/apps/app.apk"', exec("Success"));
    const result = await build().execute("/apps/app.apk");
    expect(result.success).toBe(true);
    expect("installRoute" in result).toBe(false);
    expect(adb.wasCommandExecuted("install-multiple")).toBe(false);
  });

  test("the downgrade recovery reinstalls the same split set", async () => {
    adb.setCommandResponse("install-multiple", exec("Success"));
    adb.setCommandResponseSequence("install-multiple", [
      exec("", "adb: failed to install: Failure [INSTALL_FAILED_VERSION_DOWNGRADE]"),
      exec("Success"),
    ]);
    adb.setCommandResponseSequence("shell pm list packages --user 0", [exec(`package:${APP}`)]);

    const result = await build().execute("/apps/base.apk", {
      android: { splits: ["/apps/split_config.arm64_v8a.apk"] },
    });

    expect(result.success).toBe(true);
    expect(adb.wasCommandExecuted(`uninstall ${APP}`)).toBe(true);
    expect(adb.getExecutedCommands().filter((c) => c.startsWith("install-multiple"))).toHaveLength(
      2,
    );
  });
});

describe("InstallApp app bundles", () => {
  test("builds a device-specific APK set, then installs it with modules, grant and downgrade", async () => {
    const result = await build().execute("/apps/app.aab", {
      android: {
        bundle: { modules: ["base", "dynamic_feature"], localTesting: true },
        grantAllPermissions: true,
        allowDowngrade: true,
      },
    });

    expect(result).toMatchObject({
      success: true,
      packageName: APP,
      userId: 0,
      installRoute: "bundle",
    });
    const scratch = files.createdScratchDirs[0];
    expect(argvOf("build-apks")).toEqual([
      "build-apks",
      "--bundle=/apps/app.aab",
      `--output=${path.join(scratch, "bundle.apks")}`,
      "--overwrite",
      "--connected-device",
      "--device-id=emulator-5554",
      "--local-testing",
    ]);
    expect(argvOf("install-apks")).toEqual([
      "install-apks",
      `--apks=${path.join(scratch, "bundle.apks")}`,
      "--device-id=emulator-5554",
      "--modules=base,dynamic_feature",
      "--allow-downgrade",
      "--grant-runtime-permissions",
    ]);
    expect(hostCalls("install-apks")[0]?.command).toBe(BUNDLETOOL);
    expect(files.extracted).toEqual([
      { apkSet: path.join(scratch, "bundle.apks"), destination: path.join(scratch, "base.apk") },
    ]);
    expect(aaptSources()).toEqual([path.join(scratch, "base.apk")]);
    expect(adb.wasCommandExecuted("install ")).toBe(false);
    expect(files.removedDirs).toEqual([scratch]);
  });

  test("an .apks set skips the build and installs directly", async () => {
    const result = await build().execute("/apps/app.apks", {
      android: { bundle: { modules: ["_ALL_"] } },
    });

    expect(result).toMatchObject({ success: true, packageName: APP, installRoute: "apk-set" });
    expect(hostCalls("build-apks")).toEqual([]);
    expect(argvOf("install-apks")).toContain("--apks=/apps/app.apks");
    expect(argvOf("install-apks")).toContain("--modules=_ALL_");
  });

  test("keystore passwords reach bundletool only as private file references", async () => {
    await build().execute("/apps/app.aab", {
      android: {
        bundle: {
          keystore: {
            path: "/keys/release.jks",
            alias: "release",
            storePassword: STORE_PASSWORD,
            keyPassword: KEY_PASSWORD,
          },
        },
      },
    });

    const scratch = files.createdScratchDirs[0];
    expect(argvOf("build-apks")).toEqual(
      expect.arrayContaining([
        "--ks=/keys/release.jks",
        "--ks-key-alias=release",
        `--ks-pass=file:${path.join(scratch, "ks-pass")}`,
        `--key-pass=file:${path.join(scratch, "key-pass")}`,
      ]),
    );
    expect(Object.fromEntries(files.secretFiles)).toEqual({
      [path.join(scratch, "ks-pass")]: STORE_PASSWORD,
      [path.join(scratch, "key-pass")]: KEY_PASSWORD,
    });
    const everyArgv = JSON.stringify(host.getExecutedCalls());
    expect(everyArgv).not.toContain(STORE_PASSWORD);
    expect(everyArgv).not.toContain(KEY_PASSWORD);
    expect(files.removedDirs).toEqual([scratch]);
  });

  test("the key password defaults to the store password so bundletool never prompts", async () => {
    await build().execute("/apps/app.aab", {
      android: {
        bundle: { keystore: { path: "/k.jks", alias: "a", storePassword: STORE_PASSWORD } },
      },
    });
    expect([...files.secretFiles.values()]).toEqual([STORE_PASSWORD, STORE_PASSWORD]);
  });

  test("a build failure is actionable and never echoes a keystore password", async () => {
    host.setCommandError(
      "build-apks",
      commandFailure(`Error: Keystore password '${STORE_PASSWORD}' was incorrect`),
    );

    const error = await build()
      .execute("/apps/app.aab", {
        android: {
          bundle: { keystore: { path: "/k.jks", alias: "a", storePassword: STORE_PASSWORD } },
        },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("bundletool build-apks failed");
    expect((error as Error).message).toContain("<redacted>");
    expect((error as Error).message).not.toContain(STORE_PASSWORD);
    expect(hostCalls("install-apks")).toEqual([]);
    expect(files.removedDirs).toEqual([files.createdScratchDirs[0]]);
  });

  test("a multi-line password is refused before bundletool runs", async () => {
    await expect(
      build().execute("/apps/app.aab", {
        android: {
          bundle: { keystore: { path: "/k.jks", alias: "a", storePassword: "line1\nline2" } },
        },
      }),
    ).rejects.toThrow("bundle.keystore.storePassword must not contain a line break");
    expect(hostCalls("build-apks")).toEqual([]);
  });

  test.each([
    ["/apps/app.aab", ".aab"],
    ["/apps/app.apks", ".apks"],
  ])("a missing bundletool is a typed error naming the install steps (%s)", async (artifact) => {
    bundletool.setMissing("bundletool is not on PATH and AUTOMOBILE_BUNDLETOOL_JAR is not set");

    const error = await build()
      .execute(artifact)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BundletoolNotFoundError);
    const notFound = error as BundletoolNotFoundError;
    expect(notFound.message).toContain("brew install bundletool");
    expect(notFound.message).toContain("AUTOMOBILE_BUNDLETOOL_JAR");
    expect(notFound.message).toContain("never downloads");
    expect(notFound.installSteps.length).toBeGreaterThan(0);
    expect(host.getExecutedCalls()).toEqual([]);
    expect(adb.getExecutedCommands()).toEqual([]);
    expect(files.removedDirs).toEqual(files.createdScratchDirs);
  });

  test("an install-apks version downgrade runs the existing uninstall-and-reinstall recovery", async () => {
    adb.setCommandResponseSequence("shell pm list packages --user 0", [exec(`package:${APP}`)]);
    let attempts = 0;
    const realExecute = host.executeCommand.bind(host);
    host.executeCommand = async (command, args = [], options) => {
      if (args.includes("install-apks") && ++attempts === 1) {
        await realExecute(command, args, options);
        throw commandFailure(
          "Error: Installation of the app failed.\nINSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected",
        );
      }
      return realExecute(command, args, options);
    };

    const result = await build().execute("/apps/app.apks");

    expect(result.success).toBe(true);
    expect(adb.wasCommandExecuted(`uninstall ${APP}`)).toBe(true);
    expect(hostCalls("install-apks")).toHaveLength(2);
    expect(result.warning).toContain("was newer than the artifact");
  });

  test("allowDestructiveRecovery=false leaves the newer copy installed", async () => {
    adb.setCommandResponseSequence("shell pm list packages --user 0", [exec(`package:${APP}`)]);
    host.setCommandError(
      "install-apks",
      commandFailure("INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected"),
    );

    await expect(
      build().execute("/apps/app.apks", { guard: { allowDestructiveRecovery: false } }),
    ).rejects.toThrow("bundletool install-apks failed");
    expect(adb.wasCommandExecuted("uninstall")).toBe(false);
  });

  test("the signing guard checks the installed copy of the base split's package", async () => {
    adb.setCommandResponseSequence("shell pm list packages --user 0", [exec(`package:${APP}`)]);
    const inspector = new FakePackageSigningInspector([
      signingInspection({ signerSha256: [SIGNER_A] }),
    ]);

    const result = await build(inspector).execute("/apps/app.aab", {
      guard: { expectedSigningSha256: [SIGNER_A] },
    });

    expect(result.signingGuard).toEqual({ status: "matched", matchedSha256: [SIGNER_A] });
    expect(inspector.calls).toEqual([{ appId: APP, userId: 0 }]);
  });

  test("an APK set without a base split fails the signing guard closed", async () => {
    files.apkSets.set("/apps/app.apks", false);
    const inspector = new FakePackageSigningInspector([signingInspection()]);

    const error = await build(inspector)
      .execute("/apps/app.apks", { guard: { expectedSigningSha256: [SIGNER_A] } })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SigningGuardError);
    expect((error as SigningGuardError).reason).toBe("presence-unknown");
    expect(hostCalls("install-apks")).toEqual([]);
  });

  test("an APK set without a base split still installs and reads the package from the device", async () => {
    files.apkSets.set("/apps/app.apks", false);
    // No package name, so no presence read: one listing before, one after.
    adb.setCommandResponseSequence("shell pm list packages --user 0", [
      exec(""),
      exec(`package:${APP}`),
    ]);
    const result = await build().execute("/apps/app.apks");
    expect(result).toMatchObject({ success: true, packageName: APP });
    expect(result.warning).toContain("no base split");
  });
});

describe("InstallApp Android-only options", () => {
  test.each<[string, string, InstallAppCall]>([
    ["/apps/app.aab", "splits apply only", { android: { splits: ["/a.apk"] } }],
    ["/apps/app.apk", "bundle options apply only", { android: { bundle: { modules: ["x"] } } }],
    [
      "/apps/app.apks",
      "bundle.keystore and bundle.localTesting apply only to .aab",
      { android: { bundle: { localTesting: true } } },
    ],
    ["/apps/app.apk", "Every split must be an .apk", { android: { splits: ["/apps/x.zip"] } }],
  ])("%s is refused: %s", async (artifact, message, call) => {
    await expect(build().execute(artifact, call)).rejects.toThrow(message);
    expect(adb.getExecutedCommands()).toEqual([]);
    expect(host.getExecutedCalls()).toEqual([]);
  });

  test("iOS refuses Android install options", async () => {
    const ios = new InstallApp(
      { deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", name: "iPhone", platform: "ios" },
      { create: () => adb },
      { installedAppsRepository: new FakeInstalledAppsRepository() },
    );
    await expect(
      ios.execute("/apps/App.app", { android: { grantAllPermissions: true } }),
    ).rejects.toThrow("only supported for Android devices");
  });
});
