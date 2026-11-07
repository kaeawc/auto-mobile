import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { DefaultHostCommandExecutor } from "../../../../../src/utils/HostCommandExecutor";
import { isToolInPath } from "../../../../../src/utils/android-cmdline-tools/detection";
import { DefaultSystemDetection } from "../../../../../src/utils/system/SystemDetection";
import { ENV } from "../../../../../src/config/env";
import { DefaultAndroidBuildToolsLocator } from "../../../../../src/utils/android-cmdline-tools/AndroidBuildToolsLocator";
import { AndroidDisposableAppTemplateProvider } from "../../../../../src/features/prototype/disposableApp/android/androidDisposableAppTemplateProvider";
import { AndroidDisposableAppStamper } from "../../../../../src/features/prototype/disposableApp/android/AndroidDisposableAppStamper";
import { HostKeystoreSigner } from "../../../../../src/features/prototype/disposableApp/android/DisposableAppSigner";

const configured = process.env[ENV.ANDROID_PROTOTYPE_APP_TEMPLATE.name];
const tools = configured ? await new DefaultAndroidBuildToolsLocator().findStampTools() : null;
const keytool =
  configured && tools ? await isToolInPath("keytool", new DefaultSystemDetection()) : false;
test.skipIf(!configured || !tools || !keytool)(
  "real aapt2 relinks and apksigner signs a baked spec",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "android-stamp-integration-"));
    try {
      const template = await new AndroidDisposableAppTemplateProvider().resolve();
      const stamper = new AndroidDisposableAppStamper({ cacheDir: join(directory, "cache") });
      const signer = new HostKeystoreSigner(join(directory, "key"));
      const result = await stamper.stamp({
        template,
        appId: "dev.jasonpearson.automobile.app.integration",
        label: "Feedly",
        permissions: [],
        enabledComponents: [],
        spec: '{"root":{"type":"column"}}',
        assets: [{ id: "image", bytes: Buffer.from("asset") }],
        signer,
      });
      expect(result.cacheHit).toBe(false);
      if (!tools) {
        throw new Error("SDK tools unavailable");
      }
      const executor = new DefaultHostCommandExecutor();
      await executor.executeCommand(tools.zipalign, ["-c", "-P", "16", "4", result.apkPath]);
      const manifest = await executor.executeCommand(tools.aapt2, [
        "dump",
        "xmltree",
        "--file",
        "AndroidManifest.xml",
        result.apkPath,
      ]);
      expect(manifest.stdout).toContain("Feedly");
      expect(manifest.stdout).toContain("dev.jasonpearson.automobile.app.integration");

      const zip = new AdmZip(result.apkPath);
      expect(zip.readAsText("assets/prototype/spec.json")).toContain("column");
      expect(zip.getEntry("resources.arsc")?.header.method).toBe(0);
      expect(zip.readAsText("assets/prototype/assets/image")).toBe("asset");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
