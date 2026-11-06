import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  AndroidDisposableAppTemplateProvider,
  asDisposableAppTemplate,
} from "../../../../../src/features/prototype/disposableApp/android/androidDisposableAppTemplateProvider";
import { selectDisposableAppTemplate } from "../../../../../src/features/prototype/disposableApp/disposableAppTemplates";
import { FakeFileSystem } from "../../../../fakes/FakeFileSystem";
import { stampInput } from "./androidStamperFakes";

const baseCapabilities = '{"template":"base","capabilities":[]}';
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const variable = "AUTOMOBILE_ANDROID_PROTOTYPE_APP_TEMPLATE";
async function fixture(directory: string) {
  const fs = new FakeFileSystem();
  const input = stampInput();
  fs.setDirectory(directory);
  await fs.writeFileBuffer(`${directory}/template.apk`, Buffer.from("template"));
  fs.setFile(
    `${directory}/template.json`,
    JSON.stringify({
      template: "base",
      applicationId: input.template.templatePackage,
      apkSha256: input.template.apkSha256,
      capabilitiesSha256: sha256(baseCapabilities),
    }),
  );
  fs.setFile(`${directory}/capabilities.json`, baseCapabilities);
  fs.setFile(`${directory}/AndroidManifest.xml`, input.template.manifestXml);
  return fs;
}
test("unset env explains unpublished release asset", async () => {
  await expect(
    new AndroidDisposableAppTemplateProvider(new FakeFileSystem(), {}).resolve(),
  ).rejects.toThrow("release asset is not published yet");
});
test("resolves a parent flavor directory and adapts for template selection", async () => {
  const provider = new AndroidDisposableAppTemplateProvider(await fixture("/templates/base"), {
    [variable]: "/templates",
  });
  const template = await provider.resolve();
  expect(template.apkPath).toBe(join("/templates", "base", "template.apk"));
  expect(
    selectDisposableAppTemplate({ root: { type: "column" } }, [asDisposableAppTemplate(template)])
      .name,
  ).toBe("base");
});
test("resolves a direct flavor directory and checks APK checksum", async () => {
  const fs = await fixture("/templates/base");
  const provider = new AndroidDisposableAppTemplateProvider(fs, { [variable]: "/templates/base" });
  expect((await provider.resolve()).size).toBe(8);
  await fs.writeFileBuffer("/templates/base/template.apk", Buffer.from("changed"));
  await expect(provider.resolve()).rejects.toThrow("checksum mismatch");
});
test("rejects a capabilities sidecar not packaged with the template APK", async () => {
  const fs = await fixture("/templates/base");
  fs.setFile(
    "/templates/base/capabilities.json",
    '{"template":"base","capabilities":["prototype_media_v1"]}',
  );
  const provider = new AndroidDisposableAppTemplateProvider(fs, { [variable]: "/templates/base" });
  await expect(provider.resolve()).rejects.toThrow("capabilities do not match its APK");
});
test("rejects a matching-digest sidecar that names another flavor", async () => {
  const fs = await fixture("/templates/base");
  const media = '{"template":"media","capabilities":[]}';
  fs.setFile("/templates/base/capabilities.json", media);
  const metadata = JSON.parse(await fs.readFile("/templates/base/template.json"));
  fs.setFile(
    "/templates/base/template.json",
    JSON.stringify({ ...metadata, capabilitiesSha256: sha256(media) }),
  );
  const provider = new AndroidDisposableAppTemplateProvider(fs, { [variable]: "/templates/base" });
  await expect(provider.resolve()).rejects.toThrow("capabilities do not match its APK");
});
