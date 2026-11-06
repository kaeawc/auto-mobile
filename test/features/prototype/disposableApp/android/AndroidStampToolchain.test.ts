import { expect, test } from "bun:test";
import { DefaultAndroidStampToolchain } from "../../../../../src/features/prototype/disposableApp/android/AndroidStampToolchain";
import { FakeHostCommandExecutor } from "../../../../fakes/FakeHostCommandExecutor";
import type { AndroidStampToolsLocator } from "../../../../../src/utils/android-cmdline-tools/AndroidBuildToolsLocator";
import { FakeDisposableAppSigner } from "./androidStamperFakes";

const locator: AndroidStampToolsLocator = {
  async findStampTools() {
    return {
      aapt2: "/sdk/aapt2",
      zipalign: "/sdk/zipalign",
      apksigner: "/sdk/apksigner",
      androidJar: "/sdk/android.jar",
    };
  },
};
test("toolchain links both resource tables, aligns before signing and checks signer", async () => {
  const executor = new FakeHostCommandExecutor();
  const tools = new DefaultAndroidStampToolchain(locator, executor);
  await tools.linkManifest("template.apk", "manifest.xml", "linked.apk");
  await tools.zipalign("assembled.apk", "aligned.apk");
  const signer = new FakeDisposableAppSigner();
  let signingTool = "";
  signer.sign = async (tool: string) => {
    signingTool = tool;
  };
  await tools.sign("aligned.apk", "signed.apk", signer);
  expect(signingTool).toBe("/sdk/apksigner");
  expect(executor.getExecutedCalls()[0]?.args).toEqual([
    "link",
    "-I",
    "/sdk/android.jar",
    "-I",
    "template.apk",
    "--manifest",
    "manifest.xml",
    "-o",
    "linked.apk",
  ]);
  expect(executor.getExecutedCalls()[1]?.args).toEqual([
    "-f",
    "-P",
    "16",
    "4",
    "assembled.apk",
    "aligned.apk",
  ]);
  await expect(tools.verify("signed.apk", "a".repeat(64))).rejects.toThrow("signer mismatch");
  executor.setDefaultResponse({
    stdout: `Signer #1 certificate SHA-256 digest: ${"a".repeat(64)}\n`,
    stderr: "",
    toString: () => "",
    trim: () => "",
    includes: () => false,
  });
  await tools.verify("signed.apk", "a".repeat(64));
  // Captured from apksigner 37.0.0 for a v3-only signature (no "Signer #1" line).
  executor.setDefaultResponse({
    stdout: `Verified using v3 scheme (APK Signature Scheme v3): true\nNumber of signers: 1\nV3.0 Signer: certificate DN: CN=AutoMobile Disposable Apps\nV3.0 Signer: certificate SHA-256 digest: ${"b".repeat(64)}\n`,
    stderr: "",
    toString: () => "",
    trim: () => "",
    includes: () => false,
  });
  await tools.verify("signed.apk", "b".repeat(64));
});
test("missing SDK tools fail with setup advice", async () => {
  const tools = new DefaultAndroidStampToolchain(
    {
      async findStampTools() {
        return null;
      },
    },
    new FakeHostCommandExecutor(),
  );
  await expect(tools.linkManifest("a", "b", "c")).rejects.toThrow("Install Android SDK");
});
