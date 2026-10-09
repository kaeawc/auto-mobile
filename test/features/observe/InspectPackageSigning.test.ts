import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BootedDevice } from "../../../src/models";
import {
  InspectPackageSigning,
  selectSigners,
  type ApkFetcher,
} from "../../../src/features/observe/InspectPackageSigning";
import { bufferByteSource } from "../../../src/utils/android-cmdline-tools/apkSigningBlock";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { loadSignedApk, SIGNER_A, SIGNER_B } from "../../helpers/signedApkFixtures";

const PACKAGE = "dev.jasonpearson.automobile.playground";
const APK_PATH = "/data/app/~~x/dev.jasonpearson.automobile.playground-y/base.apk";
const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

const dump = (name: string) =>
  readFileSync(
    join(import.meta.dir, "../../fixtures/android-dumpsys-package", `dumpsys-package-${name}.txt`),
    "utf8",
  );

function setup(apk: string | Error, apiLevel = "36") {
  const adb = new FakeAdbClient();
  adb.setCommandResult("shell getprop ro.build.version.sdk", `${apiLevel}\n`);
  adb.setCommandResult(`shell pm path --user 0 '${PACKAGE}'`, `package:${APK_PATH}\n`);
  adb.setCommandResult(`shell dumpsys package '${PACKAGE}'`, dump("installed"));
  const fetched: string[] = [];
  const fetcher: ApkFetcher = {
    open: async (_adb, remotePath) => {
      fetched.push(remotePath);
      if (apk instanceof Error) {
        throw apk;
      }
      return { source: bufferByteSource(loadSignedApk(apk)), dispose: async () => {} };
    },
  };
  const timer = new FakeTimer();
  timer.setCurrentTime(Date.UTC(2026, 9, 9));
  const inspector = new InspectPackageSigning(
    device,
    { create: () => adb as never },
    {
      apkFetcher: fetcher,
      timer,
    },
  );
  return { adb, inspector, fetched };
}

describe("InspectPackageSigning", () => {
  test("reports installed with a fresh, scoped signing identity", async () => {
    const { inspector, fetched } = setup("single-a");
    const result = await inspector.execute(PACKAGE, { userId: 0 });
    expect(result).toMatchObject({
      appId: PACKAGE,
      deviceId: "emulator-5554",
      userId: 0,
      userSource: "explicit",
      presence: "installed",
      state: { hidden: false, suspended: false },
      signing: { status: "available", scheme: "v3", signerSha256: [SIGNER_A] },
      observation: {
        fresh: true,
        observedAt: "2026-10-09T00:00:00.000Z",
        apiLevel: 36,
        scope: { deviceId: "emulator-5554", userId: 0, appId: PACKAGE, apkPath: APK_PATH },
      },
    });
    expect(fetched).toEqual([APK_PATH]);
  });

  test("same application ID signed by a different key is distinguishable", async () => {
    const a = await setup("single-a").inspector.execute(PACKAGE, { userId: 0 });
    const b = await setup("single-b").inspector.execute(PACKAGE, { userId: 0 });
    expect(a.signing).toMatchObject({ signerSha256: [SIGNER_A] });
    expect(b.signing).toMatchObject({ signerSha256: [SIGNER_B] });
  });

  test("lists every signer of a multi-signer package", async () => {
    const result = await setup("multi-ab").inspector.execute(PACKAGE, { userId: 0 });
    expect(result.signing).toMatchObject({
      status: "available",
      scheme: "v2",
      signerSha256: [SIGNER_B, SIGNER_A].sort(),
    });
  });

  test("rotation: API 36 sees the rotated signer with history", async () => {
    const result = await setup("rotated-b-from-a", "36").inspector.execute(PACKAGE, { userId: 0 });
    expect(result.signing).toMatchObject({
      status: "available",
      scheme: "v3.1",
      signerSha256: [SIGNER_B],
      history: [SIGNER_A, SIGNER_B],
    });
  });

  test("rotation: API 31 still sees the original signer", async () => {
    const result = await setup("rotated-b-from-a", "31").inspector.execute(PACKAGE, { userId: 0 });
    expect(result.signing).toMatchObject({ scheme: "v3", signerSha256: [SIGNER_A] });
    expect(result.signing).not.toHaveProperty("history");
  });

  test("absent is reported only from positive dumpsys evidence", async () => {
    const { adb, inspector, fetched } = setup("single-a");
    adb.setCommandResult(`shell dumpsys package '${PACKAGE}'`, dump("uninstalled-user0-keepdata"));
    const result = await inspector.execute(PACKAGE, { userId: 0 });
    expect(result.presence).toBe("absent");
    expect(result.signing.status).toBe("unavailable");
    expect(fetched).toEqual([]);
  });

  test("a failed lookup is unknown, never absent", async () => {
    const { adb, inspector } = setup("single-a");
    adb.setCommandError(`shell dumpsys package '${PACKAGE}'`, new Error("adb: device offline"));
    const result = await inspector.execute(PACKAGE, { userId: 0 });
    expect(result.presence).toBe("unknown");
    expect(result.unknownReason).toContain("device offline");
  });

  test("malformed dumpsys output is unknown, never absent", async () => {
    const { adb, inspector } = setup("single-a");
    adb.setCommandResult(`shell dumpsys package '${PACKAGE}'`, "garbage");
    expect((await inspector.execute(PACKAGE, { userId: 0 })).presence).toBe("unknown");
  });

  test("installed but unreadable APK reports signing unavailable with a reason", async () => {
    const { inspector } = setup(new Error("pull failed"));
    const result = await inspector.execute(PACKAGE, { userId: 0 });
    expect(result.presence).toBe("installed");
    expect(result.signing).toEqual({
      status: "unavailable",
      reason: "Could not read signing certificates: pull failed",
    });
  });

  test("a JAR-only APK is reported as signing unavailable", async () => {
    const result = await setup("v1-only-a").inspector.execute(PACKAGE, { userId: 0 });
    expect(result.signing).toMatchObject({ status: "unavailable" });
  });

  test("an explicit user is queried, not another profile", async () => {
    const { adb, inspector } = setup("single-a");
    adb.setCommandResult(`shell pm path --user 10 '${PACKAGE}'`, `package:${APK_PATH}\n`);
    const result = await inspector.execute(PACKAGE, { userId: 10 });
    // The captured dump only has a user 0 state line.
    expect(result.userId).toBe(10);
    expect(result.presence).toBe("unknown");
    expect(adb.wasCommandExecuted("--user 0")).toBe(false);
  });

  test("rejects a malformed package name before touching the device", async () => {
    const { adb, inspector } = setup("single-a");
    await expect(inspector.execute("bad name; rm -rf /", { userId: 0 })).rejects.toThrow(
      "Invalid Android package name",
    );
    expect(adb.getAllCommands()).toEqual([]);
  });

  test("rejects iOS devices", async () => {
    const ios = new InspectPackageSigning(
      { deviceId: "x", name: "iPhone", platform: "ios" },
      { create: () => ({}) as never },
    );
    await expect(ios.execute(PACKAGE)).rejects.toThrow("not supported");
  });
});

describe("selectSigners", () => {
  const v31 = { "v3.1": [{ sha256: "b", minSdkVersion: 33, maxSdkVersion: 99 }] };
  test("v3.1 with an unknown API level is unavailable rather than guessed", () => {
    expect(selectSigners({ ...v31, v3: [{ sha256: "a" }] }, null).status).toBe("unavailable");
  });
  test("no applicable signer is unavailable", () => {
    expect(selectSigners(v31, 30).status).toBe("unavailable");
  });
  test("signers are de-duplicated and sorted", () => {
    expect(
      selectSigners({ v2: [{ sha256: "b" }, { sha256: "a" }, { sha256: "b" }] }, 30),
    ).toMatchObject({ signerSha256: ["a", "b"] });
  });
});
