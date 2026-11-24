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
import { ANDROID_ICON_DRAWABLES } from "../../../../../src/features/prototype/disposableApp/android/AndroidStampZip";
import { resolveArscDrawablePaths } from "../../../../../src/features/prototype/disposableApp/android/androidArscColors";
import { JimpBackend } from "../../../../../src/utils/image/backend/JimpBackend";
import { loadJimp } from "../../../../../src/utils/image/loadJimp";
import { HostKeystoreSigner } from "../../../../../src/features/prototype/disposableApp/android/DisposableAppSigner";

const configured = process.env[ENV.ANDROID_PROTOTYPE_APP_TEMPLATE.name];
const tools = configured ? await new DefaultAndroidBuildToolsLocator().findStampTools() : null;
const keytool =
  configured && tools ? await isToolInPath("keytool", new DefaultSystemDetection()) : false;
for (const variant of ["monogram", "asset"] as const) {
  test.skipIf(!configured || !tools || !keytool)(
    `real aapt2 relinks and apksigner signs a baked spec with a ${variant} icon`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "android-stamp-integration-"));
      try {
        const template = await new AndroidDisposableAppTemplateProvider().resolve();
        const stamper = new AndroidDisposableAppStamper({ cacheDir: join(directory, "cache") });
        const signer = new HostKeystoreSigner(join(directory, "key"));
        const Jimp = await loadJimp();
        const artwork = await new Jimp({ width: 2, height: 1, color: 0x7248ceff }).getBuffer(
          "image/png",
        );
        const result = await stamper.stamp({
          template,
          appId: "dev.jasonpearson.automobile.app.integration",
          label: "Feedly",
          slug: "feedly",
          icon: variant === "asset" ? { asset: "image" } : { backgroundColor: "#FFC62828" },
          permissions: [],
          enabledComponents: [],
          spec: '{"root":{"type":"column"},"theme":{"colors":{"background":"#FF224466"}}}',
          assets: [{ id: "image", bytes: artwork }],
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
        const resources = await executor.executeCommand(tools.aapt2, [
          "dump",
          "resources",
          result.apkPath,
        ]);
        expect(resources.stdout.toLowerCase()).toContain(
          variant === "asset" ? "#ff224466" : "#ffc62828",
        );

        const zip = new AdmZip(result.apkPath);
        expect(zip.readAsText("assets/prototype/spec.json")).toContain("column");
        expect(zip.getEntry("resources.arsc")?.header.method).toBe(0);
        expect(zip.readFile("assets/prototype/assets/image")).toEqual(artwork);
        const original = new AdmZip(template.apkPath);
        const paths = resolveArscDrawablePaths(
          zip.getEntry("resources.arsc")!.getData(),
          Object.values(ANDROID_ICON_DRAWABLES),
        );
        const backend = new JimpBackend();
        for (const path of [...paths.values()].flatMap((entries) => [...entries])) {
          const entry = zip.getEntry(path)!;
          expect(entry.header.method).toBe(0);
          expect(entry.getData().equals(original.getEntry(path)!.getData())).toBe(false);
          const { width, height } = await backend.metadata(entry.getData());
          expect([width, height]).toEqual([432, 432]);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    60_000,
  );
}
