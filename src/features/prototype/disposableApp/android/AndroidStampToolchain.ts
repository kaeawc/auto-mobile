import { ActionableError } from "../../../../models/ActionableError";
import {
  DefaultAndroidBuildToolsLocator,
  type AndroidStampToolsLocator,
  type AndroidStampTools,
} from "../../../../utils/android-cmdline-tools/AndroidBuildToolsLocator";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../../../utils/HostCommandExecutor";
import { windowsBatchInvocation } from "../../../../utils/android-cmdline-tools/SdkManagerClient";
import type { DisposableAppSigner } from "./DisposableAppSigner";

export interface AndroidStampToolchain {
  linkManifest(template: string, manifest: string, output: string): Promise<void>;
  zipalign(input: string, output: string): Promise<void>;
  sign(input: string, output: string, signer: DisposableAppSigner): Promise<void>;
  verify(apk: string, expectedSigner: string): Promise<void>;
}
export class DefaultAndroidStampToolchain implements AndroidStampToolchain {
  constructor(
    private readonly locator: AndroidStampToolsLocator = new DefaultAndroidBuildToolsLocator(),
    private readonly executor: HostCommandExecutor = new DefaultHostCommandExecutor(),
  ) {}
  private async tools(): Promise<AndroidStampTools> {
    const tools = await this.locator.findStampTools();
    if (!tools) {
      throw new ActionableError(
        "Install Android SDK build-tools (aapt2, zipalign, apksigner) and an Android platform; set ANDROID_HOME to that SDK.",
      );
    }
    return tools;
  }
  async linkManifest(template: string, manifest: string, output: string): Promise<void> {
    const tools = await this.tools();
    await this.executor.executeCommand(tools.aapt2, [
      "link",
      "-I",
      tools.androidJar,
      "-I",
      template,
      "--manifest",
      manifest,
      "-o",
      output,
    ]);
  }
  async zipalign(input: string, output: string): Promise<void> {
    const tools = await this.tools();
    await this.executor.executeCommand(tools.zipalign, ["-f", "-P", "16", "4", input, output]);
  }
  async sign(input: string, output: string, signer: DisposableAppSigner): Promise<void> {
    await signer.sign((await this.tools()).apksigner, input, output);
  }
  async verify(apk: string, expectedSigner: string): Promise<void> {
    const invocation = windowsBatchInvocation((await this.tools()).apksigner, [
      "verify",
      "--verbose",
      "--print-certs",
      apk,
    ]);
    const result = await this.executor.executeCommand(invocation.command, invocation.args);
    const digest = result.stdout
      .split("\n")
      // apksigner names the line "Signer #1 ..." for v1/v2 and "V3.0 Signer: ..." for v3-only APKs.
      .find((line) => line.includes("certificate SHA-256 digest:"))
      ?.split("certificate SHA-256 digest:")[1]
      ?.trim()
      .replaceAll(":", "")
      .toLowerCase();
    if (digest !== expectedSigner.toLowerCase()) {
      throw new ActionableError(
        "Stamped APK signer mismatch. Remove the cached artifact and retry with the host key.",
      );
    }
  }
}
