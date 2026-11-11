import { describe, expect, test } from "bun:test";
import {
  InspectingAndroidAutoSignerCheck,
  signerMismatchReason,
  type InstalledPackageSigningReader,
} from "../../../src/features/androidAuto/AndroidAutoSignerCheck";
import { selectSigners } from "../../../src/features/observe/InspectPackageSigning";
import type {
  PackagePresence,
  PackageSigning,
  PackageSigningInspection,
} from "../../../src/models/PackageSigningInspection";
import {
  bufferByteSource,
  readApkSigningSchemes,
} from "../../../src/utils/android-cmdline-tools/apkSigningBlock";
import { loadSignedApk, type SignedApkFixture } from "../../helpers/signedApkFixtures";

const API_LEVEL = 36;

async function signingOf(fixture: SignedApkFixture): Promise<PackageSigning> {
  const schemes = await readApkSigningSchemes(bufferByteSource(loadSignedApk(fixture)));
  if (!schemes) {
    throw new Error(`${fixture} has no signing block`);
  }
  return selectSigners(schemes, API_LEVEL);
}

function inspection(presence: PackagePresence, signing: PackageSigning): PackageSigningInspection {
  return {
    appId: "com.google.android.projection.gearhead",
    platform: "android",
    deviceId: "emulator-5554",
    userId: 0,
    userSource: "installedUser",
    presence,
    signing,
    observation: {
      source: "dumpsys-package+apk-signing-block",
      fresh: true,
      observedAt: "2026-11-10T00:00:00.000Z",
      scope: {
        deviceId: "emulator-5554",
        userId: 0,
        appId: "com.google.android.projection.gearhead",
      },
      apiLevel: API_LEVEL,
    },
  };
}

function check(installed: PackageSigningInspection, apks: Record<string, SignedApkFixture>) {
  const opened: string[] = [];
  const disposed: string[] = [];
  const reader: InstalledPackageSigningReader = { execute: async () => installed };
  const signerCheck = new InspectingAndroidAutoSignerCheck(reader, async (path) => {
    opened.push(path);
    return {
      source: bufferByteSource(loadSignedApk(apks[path])),
      dispose: async () => {
        disposed.push(path);
      },
    };
  });
  return { signerCheck, opened, disposed };
}

describe("InspectingAndroidAutoSignerCheck", () => {
  test("accepts APKs carrying the installed signer and closes each one", async () => {
    const { signerCheck, opened, disposed } = check(
      inspection("installed", await signingOf("single-a")),
      {
        "base.apk": "single-a",
        "split_config.en.apk": "v3-only-a",
      },
    );
    await signerCheck.verify(["base.apk", "split_config.en.apk"]);
    expect(opened).toEqual(["base.apk", "split_config.en.apk"]);
    expect(disposed).toEqual(opened);
  });

  test("rejects an APK with a different signer before anything is installed", async () => {
    const { signerCheck, disposed } = check(inspection("installed", await signingOf("single-a")), {
      "base.apk": "single-b",
    });
    await expect(signerCheck.verify(["base.apk"])).rejects.toThrow("Android rejects an update");
    expect(disposed).toEqual(["base.apk"]);
  });

  test("accepts a rotated signer whose lineage holds the installed signer", async () => {
    const { signerCheck } = check(inspection("installed", await signingOf("single-a")), {
      "base.apk": "rotated-b-from-a",
    });
    await signerCheck.verify(["base.apk"]);
  });

  test("a phone without Android Auto points at the Play system image", async () => {
    const { signerCheck, opened } = check(
      inspection("absent", { status: "unavailable", reason: "Package is not installed" }),
      { "base.apk": "single-a" },
    );
    await expect(signerCheck.verify(["base.apk"])).rejects.toThrow("google_apis_playstore");
    expect(opened).toEqual([]);
  });
});

describe("signerMismatchReason", () => {
  test("an unreadable installed signer is a mismatch, never a pass", async () => {
    expect(
      signerMismatchReason(
        { status: "unavailable", reason: "pull failed" },
        await signingOf("single-a"),
        "base.apk",
      ),
    ).toContain("pull failed");
  });

  test("a v1-only APK has no usable signer", async () => {
    expect(
      signerMismatchReason(
        await signingOf("single-a"),
        { status: "unavailable", reason: "v1 only" },
        "base.apk",
      ),
    ).toContain("base.apk has no usable signer");
  });
});
