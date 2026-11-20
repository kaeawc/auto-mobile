import { describe, expect, test } from "bun:test";
import {
  AndroidBundletool,
  REDACTED_SECRET,
  scrubBundletoolText,
} from "../../../src/features/action/AndroidBundletool";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { runExecSeam } from "../../../src/utils/ExecSeam";
import type { ToolCallCapture } from "../../../src/utils/fixtureCapture/fixtureCaptureFormat";
import { runWithFixtureCapture } from "../../../src/utils/fixtureCapture/fixtureCaptureScope";
import type { HostCommandExecutor } from "../../../src/utils/HostCommandExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
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

describe("AndroidBundletool.buildApks fixture capture", () => {
  test("a capture holds the scrubbed build-apks output and marks it redacted", async () => {
    const timer = new FakeTimer();
    const captures: ToolCallCapture[] = [];
    // Runs each command through the real exec seam, so the capture sees what bundletool echoed.
    const seamHost: HostCommandExecutor = {
      executeCommand: (file, args = []) =>
        runExecSeam(
          async () => ({ stdout: "", stderr: `Keystore password 'ks-s3cret' was incorrect` }),
          {},
          { command: file, args },
        ),
    };
    const tool = new AndroidBundletool({
      hostExecutor: seamHost,
      locator: new FakeBundletoolLocator(),
      artifactHost: new FakeAndroidArtifactHost(),
      adbPath: async () => "/sdk/platform-tools/adb",
      deviceId: "emulator-5554",
    });
    const request = {
      bundle: { keystore: { path: "/k.jks", alias: "a", storePassword: "ks-s3cret" } },
    };
    await runWithFixtureCapture(
      "installApp",
      {
        writer: { write: async (capture) => void captures.push(capture) },
        timer,
        sourceIdentity: async () => ({ automobileVersion: "0", sourceTreeState: "clean" }),
      },
      () => tool.buildApks("/app.aab", request, "/scratch"),
    );
    const [command] = captures[0]?.commands ?? [];
    expect(command?.stderr).toBe(`Keystore password '${REDACTED_SECRET}' was incorrect`);
    expect(command?.redacted).toBe(true);
    expect(JSON.stringify(captures)).not.toContain("ks-s3cret");
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
