import { describe, expect, test } from "bun:test";
import {
  AndroidBundletool,
  REDACTED_SECRET,
  scrubBundletoolText,
} from "../../../src/features/action/AndroidBundletool";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { FakeAndroidArtifactHost } from "../../fakes/FakeAndroidArtifactHost";
import { FakeBundletoolLocator } from "../../fakes/FakeBundletoolLocator";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";

function bundletool(hostExecutor: FakeHostCommandExecutor, locator = new FakeBundletoolLocator()) {
  return new AndroidBundletool({
    hostExecutor,
    locator,
    artifactHost: new FakeAndroidArtifactHost(),
    adbPath: async () => "/sdk/platform-tools/adb",
    deviceId: "emulator-5554",
  });
}

describe("scrubBundletoolText", () => {
  test("replaces every occurrence of every secret and ignores empty ones", () => {
    expect(scrubBundletoolText("a pw b pw c key", ["pw", "", "key"])).toBe(
      `a ${REDACTED_SECRET} b ${REDACTED_SECRET} c ${REDACTED_SECRET}`,
    );
  });
});

describe("AndroidBundletool.installApks", () => {
  test("a killed (timed-out) install is reported as timed out for the recovery", async () => {
    const host = new FakeHostCommandExecutor();
    const raw = Object.assign(new Error("Command failed"), {
      killed: true,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
    });
    host.setCommandError("install-apks", new Error("Command failed: bundletool", { cause: raw }));

    const attempt = await bundletool(host).installApks("/tmp/app.apks", {});

    expect(attempt).toMatchObject({ success: false, threw: true, timedOut: true });
    expect(attempt.output).toContain("timed out");
    expect(host.getExecutedCalls()[0]?.options?.timeoutMs).toBe(120_000);
  });

  test("the APK set path never matches the downgrade code", async () => {
    const host = new FakeHostCommandExecutor();
    const apks = "/tmp/INSTALL_FAILED_VERSION_DOWNGRADE/app.apks";
    const raw = Object.assign(new Error("x"), { stderr: `Failed to read ${apks}`, stdout: "" });
    host.setCommandError("install-apks", new Error("wrapped", { cause: raw }));

    const attempt = await bundletool(host).installApks(apks, {});

    expect(attempt.versionDowngrade).toBe(false);
    expect(attempt.diagnostics).toBe("Failed to read <apks>");
  });

  test("a cancelled install propagates instead of becoming a failed attempt", async () => {
    const host = new FakeHostCommandExecutor();
    host.setCommandError("install-apks", new Error(OPERATION_CANCELLED_MESSAGE));
    const controller = new AbortController();
    controller.abort();

    await expect(
      bundletool(host).installApks("/tmp/app.apks", {}, controller.signal),
    ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
  });

  test("passes an absolute adb path to bundletool", async () => {
    const host = new FakeHostCommandExecutor();

    await bundletool(host).installApks("/tmp/app.apks", { allowDowngrade: true });

    expect(host.getExecutedCalls()[0]?.args).toEqual([
      "install-apks",
      "--apks=/tmp/app.apks",
      "--device-id=emulator-5554",
      "--adb=/sdk/platform-tools/adb",
      "--allow-downgrade",
    ]);
  });

  test("bundletool is located once per instance", async () => {
    const host = new FakeHostCommandExecutor();
    const locator = new FakeBundletoolLocator();
    const tool = bundletool(host, locator);

    await tool.resolve(".apks");
    await tool.installApks("/tmp/app.apks", {});

    expect(locator.locateCalls).toBe(1);
  });
});
