import { beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { InstallApp } from "../../../src/features/action/InstallApp";
import { SigningGuardError } from "../../../src/models/SigningGuardError";
import { createPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAndroidBuildToolsLocator } from "../../fakes/FakeAndroidBuildToolsLocator";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import {
  FakePackageSigningInspector,
  signingInspection,
} from "../../fakes/FakePackageSigningInspector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { SIGNER_A, SIGNER_B } from "../../helpers/signedApkFixtures";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const APK = "/tmp/app-debug.apk";
const APP = "com.example.app";

const exec = (stdout: string, stderr = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (search: string) => stdout.includes(search),
});

let adb: FakeAdbExecutor;
let timer: FakeTimer;

function build(script: Parameters<typeof signingInspection>[0][] | Error[]) {
  const host = new FakeHostCommandExecutor();
  const locator = new FakeAndroidBuildToolsLocator();
  locator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
  host.setCommandResponse("aapt2", exec(`package: name='${APP}' versionCode='1'`));
  const inspector = new FakePackageSigningInspector(
    script.map((entry) => (entry instanceof Error ? entry : signingInspection(entry))),
  );
  const install = new InstallApp(
    device,
    { create: () => adb },
    {
      hostExecutor: host,
      buildToolsLocator: locator,
      performanceTrackerFactory: () => createPerformanceTracker(false, timer),
      timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      signingInspector: inspector,
    },
  );
  return { install, inspector };
}

beforeEach(() => {
  adb = new FakeAdbExecutor();
  timer = new FakeTimer();
  timer.enableAutoAdvance();
  adb.setUsers([{ userId: 0, name: "Owner", flags: 13, running: true }]);
  adb.setCommandResponse("shell pm list packages --user 0", exec(`package:${APP}`));
  adb.setCommandResponse(`install --user 0 -r "${APK}"`, exec("Success"));
});

const installed = () => adb.wasCommandExecuted(`install --user 0 -r "${APK}"`);

describe("InstallApp signing guard", () => {
  test("replacing a copy signed by another key is refused before installing", async () => {
    const { install } = build([{ signerSha256: [SIGNER_B] }]);
    const error = await install
      .execute(APK, 0, undefined, { expectedSigningSha256: [SIGNER_A] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SigningGuardError);
    expect((error as SigningGuardError).reason).toBe("mismatch");
    expect(installed()).toBe(false);
  });

  test("a multi-signer copy needs the complete expected set", async () => {
    const { install } = build([{ signerSha256: [SIGNER_A, SIGNER_B] }]);
    await expect(
      install.execute(APK, 0, undefined, { expectedSigningSha256: [SIGNER_B] }),
    ).rejects.toMatchObject({ reason: "mismatch" });
    expect(installed()).toBe(false);
  });

  test("unreadable signers refuse the replacement", async () => {
    const { install } = build([{ signing: { status: "unavailable", reason: "no signing block" } }]);
    await expect(
      install.execute(APK, 0, undefined, { expectedSigningSha256: [SIGNER_A] }),
    ).rejects.toMatchObject({ reason: "signing-unavailable" });
    expect(installed()).toBe(false);
  });

  test("an unknown lookup refuses the replacement", async () => {
    const { install } = build([{ presence: "unknown", unknownReason: "timed out" }]);
    await expect(
      install.execute(APK, 0, undefined, { expectedSigningSha256: [SIGNER_A] }),
    ).rejects.toMatchObject({ reason: "presence-unknown" });
    expect(installed()).toBe(false);
  });

  test("a matching copy is replaced on the same explicit user", async () => {
    const { install, inspector } = build([{ signerSha256: [SIGNER_A] }]);
    const result = await install.execute(APK, 0, undefined, {
      expectedSigningSha256: [SIGNER_A],
    });
    expect(result).toMatchObject({
      success: true,
      userId: 0,
      signingGuard: { status: "matched", matchedSha256: [SIGNER_A] },
    });
    expect(inspector.calls).toEqual([{ appId: APP, userId: 0 }]);
    expect(installed()).toBe(true);
  });

  test("nothing installed means nothing to replace", async () => {
    adb.setCommandResponseSequence("shell pm list packages --user 0", [
      exec("package:com.android.settings"),
      exec("package:com.android.settings"),
      exec("package:com.android.settings"),
      exec(`package:${APP}`),
    ]);
    const { install, inspector } = build([{ signerSha256: [SIGNER_B] }]);
    const result = await install.execute(APK, 0, undefined, {
      expectedSigningSha256: [SIGNER_A],
    });
    expect(result.signingGuard).toEqual({ status: "no-existing-package" });
    expect(inspector.calls).toEqual([]);
    expect(installed()).toBe(true);
  });

  test("without guards no inspection happens and the result has no guard field", async () => {
    const { install, inspector } = build([{ signerSha256: [SIGNER_B] }]);
    const result = await install.execute(APK, 0);
    expect(result.success).toBe(true);
    expect(result).not.toHaveProperty("signingGuard");
    expect(inspector.calls).toEqual([]);
  });

  test("disabled destructive recovery fails a downgrade without uninstalling", async () => {
    adb.setCommandResponse(
      `install --user 0 -r "${APK}"`,
      exec("", "Failure [INSTALL_FAILED_VERSION_DOWNGRADE]"),
    );
    const { install } = build([]);
    const result = await install.execute(APK, 0, undefined, { allowDestructiveRecovery: false });
    expect(result.success).toBe(false);
    expect(result.warning).toContain("existing package was left installed");
    expect(adb.getExecutedCommands().some((command) => command.includes("uninstall"))).toBe(false);
  });

  test("destructive recovery stays on by default", async () => {
    adb.setCommandResponseSequence(`install --user 0 -r "${APK}"`, [
      exec("", "Failure [INSTALL_FAILED_VERSION_DOWNGRADE]"),
      exec("Success"),
    ]);
    const { install } = build([]);
    const result = await install.execute(APK, 0, undefined, { allowDestructiveRecovery: true });
    expect(result.success).toBe(true);
    expect(adb.wasCommandExecuted("uninstall com.example.app")).toBe(true);
  });

  test("iOS devices reject the guards", async () => {
    const ios = new InstallApp({ deviceId: "x", name: "iPhone", platform: "ios" }, undefined, {
      installedAppsRepository: new FakeInstalledAppsRepository(),
    });
    await expect(
      ios.execute("/tmp/App.app", undefined, undefined, { expectedSigningSha256: [SIGNER_A] }),
    ).rejects.toThrow("only supported for Android");
  });
});
