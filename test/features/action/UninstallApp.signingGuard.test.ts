import { beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { UninstallApp } from "../../../src/features/action/UninstallApp";
import { SigningGuardError } from "../../../src/models/SigningGuardError";
import { resetDbWriteBarrier } from "../../../src/db/dbWriteBarrier";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeDeviceWindowCacheInvalidator } from "../../fakes/FakeDeviceWindowCacheInvalidator";
import {
  FakePackageSigningInspector,
  signingInspection,
} from "../../fakes/FakePackageSigningInspector";
import { SIGNER_A, SIGNER_B } from "../../helpers/signedApkFixtures";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const APP = "com.example.app";
const installed = (signers: string[]) => signingInspection({ signerSha256: signers });
const absent = signingInspection({
  presence: "absent",
  signing: { status: "unavailable", reason: "Package is not installed" },
});

let adb: FakeAdbClient;

function build(script: Array<ReturnType<typeof signingInspection> | Error>) {
  const inspector = new FakePackageSigningInspector(script);
  const uninstall = new UninstallApp(
    device,
    { create: () => adb as never },
    {
      installedAppsRepository: new FakeInstalledAppsRepository(),
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
      signingInspector: inspector,
    },
  );
  return { inspector, uninstall };
}

const uninstalled = () => adb.wasCommandExecuted("shell pm uninstall");

beforeEach(() => {
  resetDbWriteBarrier();
  adb = new FakeAdbClient();
  adb.setUsers([{ userId: 0, name: "Owner", flags: 0x13, running: true }]);
  // Present before the uninstall, gone after.
  adb.setCommandResultSequence("shell pm list packages --user 0", [
    { stdout: `package:${APP}` },
    { stdout: "package:com.android.settings" },
  ]);
});

describe("UninstallApp signing guard", () => {
  test("a different key leaves the installed package untouched", async () => {
    const { uninstall } = build([installed([SIGNER_B])]);
    const error = await uninstall
      .execute(APP, false, 0, undefined, { expectedSigningSha256: [SIGNER_A] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SigningGuardError);
    expect((error as SigningGuardError).reason).toBe("mismatch");
    expect((error as SigningGuardError).details).toMatchObject({
      expectedSha256: [SIGNER_A],
      actualSha256: [SIGNER_B],
    });
    expect(uninstalled()).toBe(false);
    expect(adb.wasCommandExecuted("force-stop")).toBe(false);
  });

  test("one shared signer of a multi-signer package does not satisfy the guard", async () => {
    const { uninstall } = build([installed([SIGNER_A, SIGNER_B])]);
    await expect(
      uninstall.execute(APP, false, 0, undefined, { expectedSigningSha256: [SIGNER_A] }),
    ).rejects.toMatchObject({ reason: "mismatch" });
    expect(uninstalled()).toBe(false);
  });

  test("a matching package is removed with data and confirmed absent", async () => {
    const { uninstall, inspector } = build([installed([SIGNER_A]), absent]);
    const result = await uninstall.execute(APP, false, 0, undefined, {
      expectedSigningSha256: [SIGNER_A.toUpperCase()],
    });
    expect(result).toMatchObject({
      success: true,
      wasInstalled: true,
      userId: 0,
      keepData: false,
      signingGuard: { matchedSha256: [SIGNER_A] },
      removalVerification: "absent",
    });
    expect(adb.wasCommandExecuted("shell pm uninstall --user 0 'com.example.app'")).toBe(true);
    // Inspection, mutation and verification all stay on the same explicit user.
    expect(inspector.calls).toEqual([
      { appId: APP, userId: 0 },
      { appId: APP, userId: 0 },
    ]);
  });

  test("an absent package refuses rather than silently succeeding", async () => {
    adb.setCommandResultSequence("shell pm list packages --user 0", [
      { stdout: "package:com.android.settings" },
    ]);
    const { uninstall } = build([absent]);
    await expect(
      uninstall.execute(APP, false, 0, undefined, { expectedSigningSha256: [SIGNER_A] }),
    ).rejects.toMatchObject({ reason: "absent" });
  });

  test("a failed identity lookup refuses before any destructive step", async () => {
    const { uninstall } = build([
      signingInspection({ presence: "unknown", unknownReason: "dumpsys timed out" }),
    ]);
    await expect(
      uninstall.execute(APP, false, 0, undefined, { expectedSigningSha256: [SIGNER_A] }),
    ).rejects.toMatchObject({ reason: "presence-unknown" });
    expect(uninstalled()).toBe(false);
  });

  test("unreadable signers refuse before any destructive step", async () => {
    const { uninstall } = build([
      signingInspection({ signing: { status: "unavailable", reason: "no signing block" } }),
    ]);
    await expect(
      uninstall.execute(APP, false, 0, undefined, { expectedSigningSha256: [SIGNER_A] }),
    ).rejects.toMatchObject({ reason: "signing-unavailable" });
    expect(uninstalled()).toBe(false);
  });

  test("an inspection of another profile is refused", async () => {
    const { uninstall } = build([signingInspection({ userId: 10, signerSha256: [SIGNER_A] })]);
    await expect(
      uninstall.execute(APP, false, 0, undefined, { expectedSigningSha256: [SIGNER_A] }),
    ).rejects.toMatchObject({ reason: "presence-unknown" });
    expect(uninstalled()).toBe(false);
  });

  test("inconclusive post-removal read is not a verified success", async () => {
    const { uninstall } = build([installed([SIGNER_A]), new Error("adb offline")]);
    const result = await uninstall.execute(APP, false, 0, undefined, {
      expectedSigningSha256: [SIGNER_A],
    });
    expect(result).toMatchObject({ success: false, removalVerification: "unknown" });
    expect(result.error).toContain("could not be verified");
  });

  test("a fresh read that still sees the package fails even if pm list no longer does", async () => {
    const { uninstall } = build([installed([SIGNER_A]), installed([SIGNER_A])]);
    const result = await uninstall.execute(APP, false, 0, undefined, {
      expectedSigningSha256: [SIGNER_A],
    });
    expect(result).toMatchObject({ success: false, removalVerification: "installed" });
  });

  test("without a guard no inspection happens and the result is unchanged", async () => {
    const { uninstall, inspector } = build([installed([SIGNER_B])]);
    const result = await uninstall.execute(APP, false, 0);
    expect(result.success).toBe(true);
    expect(result).not.toHaveProperty("signingGuard");
    expect(result).not.toHaveProperty("removalVerification");
    expect(inspector.calls).toEqual([]);
  });

  test("iOS devices reject the guard", async () => {
    const ios = new UninstallApp({ deviceId: "x", name: "iPhone", platform: "ios" }, undefined, {
      installedAppsRepository: new FakeInstalledAppsRepository(),
    });
    await expect(
      ios.execute(APP, false, undefined, undefined, { expectedSigningSha256: [SIGNER_A] }),
    ).rejects.toThrow("only supported for Android");
  });
});
